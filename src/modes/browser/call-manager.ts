import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import type { DiscordWeb } from './discord-web.js';
import type { AudioBridge } from './audio-bridge.js';
import type { STTProvider } from '../../providers/stt/interface.js';
import { SAMPLE_RATE } from './audio-bridge.js';

export interface CallManagerConfig {
  targetUserId: string;
  responseCallback?: (transcription: string) => Promise<string>;
}

export type CallState = 'idle' | 'calling' | 'ringing' | 'connected' | 'hanging-up';

/**
 * Orchestrates the full voice call flow:
 * 1. Start or answer a call
 * 2. Capture tab audio → STT transcription
 * 3. Send transcription to response handler (e.g., OpenClaw API)
 * 4. Generate TTS response → play to BlackHole → Discord
 * 5. Handle hang up
 */
export class CallManager extends EventEmitter {
  private discordWeb: DiscordWeb;
  private audioBridge: AudioBridge;
  private sttProvider: STTProvider;
  private config: CallManagerConfig;

  private state: CallState = 'idle';
  private audioChunks: Buffer[] = [];
  private silenceStartTime: number | null = null;
  private processing = false;
  private tmpDir: string;

  // VAD settings
  private readonly SILENCE_THRESHOLD_MS = 1500;
  private readonly MIN_AUDIO_DURATION_MS = 500;

  constructor(
    discordWeb: DiscordWeb,
    audioBridge: AudioBridge,
    sttProvider: STTProvider,
    config: CallManagerConfig
  ) {
    super();
    this.discordWeb = discordWeb;
    this.audioBridge = audioBridge;
    this.sttProvider = sttProvider;
    this.config = config;
    this.tmpDir = mkdtempSync(join(tmpdir(), 'call-manager-'));

    // Handle audio chunks from the bridge
    this.audioBridge.on('audio', (pcmBuffer: Buffer) => {
      this.handleAudioChunk(pcmBuffer);
    });
  }

  /**
   * Get current call state
   */
  getState(): CallState {
    return this.state;
  }

  /**
   * Set the response callback (called with transcription, returns response text)
   */
  setResponseCallback(callback: (transcription: string) => Promise<string>): void {
    this.config.responseCallback = callback;
  }

  /**
   * Start an outgoing call to the target user
   */
  async startCall(userId?: string): Promise<boolean> {
    const targetId = userId ?? this.config.targetUserId;

    if (this.state !== 'idle') {
      logger.warn(`Cannot start call — current state: ${this.state}`);
      return false;
    }

    this.setState('calling');

    try {
      // Navigate to the user's DM
      const dmOk = await this.discordWeb.navigateToDM(targetId);
      if (!dmOk) {
        this.setState('idle');
        return false;
      }

      // Start the voice call
      const callOk = await this.discordWeb.startCall();
      if (!callOk) {
        this.setState('idle');
        return false;
      }

      this.setState('connected');

      // Start capturing audio
      await this.audioBridge.startCapture();

      logger.info('Call started and audio capture active');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to start call: ${message}`);
      this.setState('idle');
      this.emitError(error);
      return false;
    }
  }

  /**
   * Answer an incoming call
   */
  async answerCall(): Promise<boolean> {
    if (this.state !== 'idle' && this.state !== 'ringing') {
      logger.warn(`Cannot answer call — current state: ${this.state}`);
      return false;
    }

    this.setState('ringing');

    try {
      const answered = await this.discordWeb.answerCall();
      if (!answered) {
        this.setState('idle');
        return false;
      }

      this.setState('connected');

      // Start capturing audio
      await this.audioBridge.startCapture();

      logger.info('Call answered and audio capture active');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to answer call: ${message}`);
      this.setState('idle');
      this.emitError(error);
      return false;
    }
  }

  /**
   * Hang up the current call
   */
  async hangUp(): Promise<void> {
    if (this.state === 'idle') return;

    this.setState('hanging-up');

    // Stop audio capture
    await this.audioBridge.stopCapture();
    this.audioBridge.stopPlayback();

    // End the call in Discord
    await this.discordWeb.hangUp();

    // Clear any buffered audio
    this.audioChunks = [];
    this.silenceStartTime = null;
    this.processing = false;

    this.setState('idle');
    logger.info('Call ended');
  }

  /**
   * Speak text in the current call (TTS → BlackHole → Discord)
   */
  async speak(text: string): Promise<void> {
    if (this.state !== 'connected') {
      logger.warn('Cannot speak — not in a call');
      return;
    }

    await this.audioBridge.speak(text);
    this.emit('response', text);
  }

  /**
   * Start watching for incoming calls
   */
  startIncomingCallWatch(): void {
    this.discordWeb.onIncomingCall(async () => {
      logger.info('Incoming call detected, auto-answering...');
      await this.answerCall();
    });
  }

  /**
   * Stop watching for incoming calls
   */
  stopIncomingCallWatch(): void {
    this.discordWeb.stopIncomingCallWatch();
  }

  /**
   * Clean up all resources
   */
  async dispose(): Promise<void> {
    await this.hangUp();
    this.stopIncomingCallWatch();
    await this.audioBridge.dispose();
  }

  /**
   * Handle incoming audio chunks from the capture bridge
   */
  private handleAudioChunk(pcmBuffer: Buffer): void {
    if (this.state !== 'connected' || this.processing) return;

    this.audioChunks.push(pcmBuffer);
    this.silenceStartTime = null; // Reset silence timer — we got audio

    // Start a silence detection timer
    if (!this.silenceStartTime) {
      setTimeout(() => {
        void this.checkSilenceAndProcess();
      }, this.SILENCE_THRESHOLD_MS);
    }
  }

  /**
   * Check if enough silence has passed and process accumulated audio
   */
  private async checkSilenceAndProcess(): Promise<void> {
    if (this.processing || this.audioChunks.length === 0) return;

    // Calculate total audio duration
    const totalSamples = this.audioChunks.reduce((sum, buf) => sum + buf.length / 2, 0);
    const durationMs = (totalSamples / SAMPLE_RATE) * 1000;

    if (durationMs < this.MIN_AUDIO_DURATION_MS) {
      this.audioChunks = [];
      return;
    }

    this.processing = true;

    try {
      // Concatenate all audio chunks
      const combined = Buffer.concat(this.audioChunks);
      this.audioChunks = [];

      // Write PCM to a temp WAV file for STT
      const wavPath = join(this.tmpDir, `capture-${Date.now()}.wav`);
      this.writeWav(wavPath, combined);

      // Transcribe
      const transcription = await this.sttProvider.transcribe(wavPath);

      // Clean up
      try {
        unlinkSync(wavPath);
      } catch {
        // Ignore
      }

      if (!transcription || transcription.trim().length === 0) {
        this.processing = false;
        return;
      }

      logger.info(`Transcription: "${transcription}"`);
      this.emit('transcription', transcription);

      // Send to response callback if available
      if (this.config.responseCallback) {
        try {
          const response = await this.config.responseCallback(transcription);
          if (response) {
            await this.speak(response);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`Response callback failed: ${msg}`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Audio processing failed: ${msg}`);
      this.emitError(error);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Write raw PCM Int16 data as a WAV file
   */
  private writeWav(path: string, pcmData: Buffer): void {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (SAMPLE_RATE * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const headerSize = 44;

    const header = Buffer.alloc(headerSize);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + headerSize - 8, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    writeFileSync(path, Buffer.concat([header, pcmData]));
  }

  private setState(state: CallState): void {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      logger.info(`Call state: ${prev} → ${state}`);
      this.emit('stateChange', state);
    }
  }

  private emitError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.emit('error', err);
  }
}
