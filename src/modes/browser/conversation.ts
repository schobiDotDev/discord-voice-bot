import { mkdtempSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import { Recorder, type RecorderConfig } from './recorder.js';
import { Speaker, type SpeakerConfig } from './speaker.js';
import type { STTProvider } from '../../providers/stt/interface.js';
import type { TTSProvider } from '../../providers/tts/interface.js';

// Known Whisper hallucination patterns (in German and English)
const HALLUCINATION_PATTERNS = [
  'untertitel der amara.org-community',
  'untertitel von der amara.org',
  'untertitelung',
  'subtitles by',
  'thank you for watching',
  'danke fürs zuschauen',
  'vielen dank für ihre aufmerksamkeit',
  'www.',
  'http',
  'copyright',
  '♪',
  '♫',
];

export interface ConversationConfig {
  inputDeviceIndex: number;
  outputDevice: string;
  systemDevice: string;
  sampleRate: number;
  channels: number;
  chunkSeconds: number;
  volumeThresholdDb: number;
  silenceDurationMs: number;
  minSpeechDurationMs: number;
  language: string;
}

export interface ConversationHandlers {
  onTranscription?: (text: string) => void;
  onResponse?: (text: string) => void;
  responseCallback?: (transcription: string) => Promise<string>;
}

export type ConversationState = 'idle' | 'listening' | 'processing' | 'speaking';

/**
 * Manages the continuous listen-transcribe-respond loop
 * Uses VAD to detect speech and silence
 */
export class ConversationLoop extends EventEmitter {
  private config: ConversationConfig;
  private recorder: Recorder;
  private speaker: Speaker;
  private sttProvider: STTProvider;
  private handlers: ConversationHandlers;

  private state: ConversationState = 'idle';
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private tmpDir: string;

  constructor(
    config: ConversationConfig,
    sttProvider: STTProvider,
    ttsProvider: TTSProvider,
    handlers: ConversationHandlers = {}
  ) {
    super();
    this.config = config;
    this.sttProvider = sttProvider;
    this.handlers = handlers;

    // Create temp directory for audio files
    this.tmpDir = mkdtempSync(join(tmpdir(), 'discord-voice-conversation-'));

    // Initialize recorder
    const recorderConfig: RecorderConfig = {
      inputDeviceIndex: config.inputDeviceIndex,
      sampleRate: config.sampleRate,
      channels: config.channels,
      chunkSeconds: config.chunkSeconds,
      volumeThresholdDb: config.volumeThresholdDb,
    };
    this.recorder = new Recorder(recorderConfig, this.tmpDir);

    // Initialize speaker
    const speakerConfig: SpeakerConfig = {
      outputDevice: config.outputDevice,
      systemDevice: config.systemDevice,
      ttsProvider,
    };
    this.speaker = new Speaker(speakerConfig, this.tmpDir);
  }

  /**
   * Get current conversation state
   */
  getState(): ConversationState {
    return this.state;
  }

  /**
   * Check if the loop is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Set the response callback
   */
  setResponseCallback(callback: (transcription: string) => Promise<string>): void {
    this.handlers.responseCallback = callback;
  }

  /**
   * Start the conversation loop
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Conversation loop already running');
      return;
    }

    logger.info('Starting conversation loop...');
    this.running = true;
    this.setState('listening');

    this.loopPromise = this.runLoop();
  }

  /**
   * Stop the conversation loop
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info('Stopping conversation loop...');
    this.running = false;
    this.recorder.stop();
    this.speaker.stop();

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    this.setState('idle');
  }

  /**
   * Speak text (interrupts current listening)
   */
  async speak(text: string): Promise<void> {
    const prevState = this.state;
    this.setState('speaking');

    try {
      await this.speaker.speak(text);
      this.handlers.onResponse?.(text);
      this.emit('response', text);
    } finally {
      if (this.running) {
        this.setState(prevState === 'speaking' ? 'listening' : prevState);
      }
    }
  }

  /**
   * Listen for a single utterance and return transcription
   */
  async listenOnce(): Promise<string | null> {
    const prevState = this.state;
    this.setState('listening');

    try {
      const speechChunks = await this.collectSpeechChunks();
      if (speechChunks.length === 0) {
        return null;
      }

      this.setState('processing');

      const transcription = await this.transcribeChunks(speechChunks);
      
      // Clean up chunks
      speechChunks.forEach((chunk) => this.recorder.cleanupChunk(chunk));

      return transcription;
    } finally {
      if (this.running) {
        this.setState(prevState);
      } else {
        this.setState('idle');
      }
    }
  }

  /**
   * Main conversation loop
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        // Listen for speech
        this.setState('listening');
        const speechChunks = await this.collectSpeechChunks();

        if (!this.running) break;
        if (speechChunks.length === 0) continue;

        // Transcribe
        this.setState('processing');
        const transcription = await this.transcribeChunks(speechChunks);

        // Clean up chunks
        speechChunks.forEach((chunk) => this.recorder.cleanupChunk(chunk));

        if (!transcription) continue;

        // Emit and handle transcription
        this.handlers.onTranscription?.(transcription);
        this.emit('transcription', transcription);

        // Get response if callback is set
        if (this.handlers.responseCallback) {
          try {
            const response = await this.handlers.responseCallback(transcription);
            if (response && this.running) {
              this.setState('speaking');
              await this.speaker.speak(response);
              this.handlers.onResponse?.(response);
              this.emit('response', response);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Response callback failed: ${msg}`);
            this.emit('error', error);
          }
        }
      } catch (error) {
        if (!this.running) break;

        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Conversation loop error: ${msg}`);
        this.emit('error', error);

        // Brief pause before retry
        await this.delay(1000);
      }
    }
  }

  /**
   * Collect speech chunks until silence is detected
   */
  private async collectSpeechChunks(): Promise<string[]> {
    const chunks: string[] = [];
    let silenceStart: number | null = null;
    let speechDetected = false;

    while (this.running) {
      try {
        const { filePath, volumeDb } = await this.recorder.recordChunk();
        const isSpeech = this.recorder.isSpeech(volumeDb);

        logger.debug(`Chunk volume: ${volumeDb.toFixed(1)} dB, speech: ${isSpeech}`);

        if (isSpeech) {
          chunks.push(filePath);
          speechDetected = true;
          silenceStart = null;
        } else if (speechDetected) {
          // We had speech but now have silence
          if (silenceStart === null) {
            silenceStart = Date.now();
          }

          // Check if silence duration exceeded
          const silenceDuration = Date.now() - silenceStart;
          if (silenceDuration >= this.config.silenceDurationMs) {
            logger.debug(`Silence detected for ${silenceDuration}ms, processing speech`);
            this.recorder.cleanupChunk(filePath);
            break;
          }

          // Keep the chunk in case speech resumes
          chunks.push(filePath);
        } else {
          // No speech detected yet, discard the chunk
          this.recorder.cleanupChunk(filePath);
        }
      } catch (error) {
        if (!this.running) break;

        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Chunk recording failed: ${msg}`);
        await this.delay(500);
      }
    }

    // Check minimum speech duration
    const totalDurationMs = chunks.length * this.config.chunkSeconds * 1000;
    if (totalDurationMs < this.config.minSpeechDurationMs) {
      logger.debug(`Speech too short (${totalDurationMs}ms), discarding`);
      chunks.forEach((chunk) => this.recorder.cleanupChunk(chunk));
      return [];
    }

    return chunks;
  }

  /**
   * Transcribe audio chunks
   */
  private async transcribeChunks(chunkPaths: string[]): Promise<string | null> {
    if (chunkPaths.length === 0) {
      return null;
    }

    const combinedPath = `${this.tmpDir}/combined-${Date.now()}.wav`;

    try {
      // Concatenate chunks
      await this.recorder.concatenateChunks(chunkPaths, combinedPath);

      // Transcribe
      const transcription = await this.sttProvider.transcribe(combinedPath, this.config.language);

      // Check for hallucinations
      if (this.isHallucination(transcription)) {
        logger.debug(`Filtered hallucination: "${transcription}"`);
        return null;
      }

      if (!transcription || transcription.trim().length === 0) {
        return null;
      }

      logger.info(`Transcription: "${transcription}"`);
      return transcription;
    } finally {
      // Clean up combined file
      try {
        if (existsSync(combinedPath)) {
          unlinkSync(combinedPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Check if transcription is a known hallucination pattern
   */
  private isHallucination(text: string | null): boolean {
    if (!text) return true;

    const lower = text.toLowerCase().trim();

    // Too short
    if (lower.length < 2) return true;

    // Check known patterns
    for (const pattern of HALLUCINATION_PATTERNS) {
      if (lower.includes(pattern)) {
        return true;
      }
    }

    // Repeated text pattern (e.g., "Yeah. Yeah. Yeah.")
    const words = lower.split(/\s+/);
    if (words.length >= 3) {
      const unique = new Set(words);
      if (unique.size === 1) return true;
    }

    return false;
  }

  private setState(state: ConversationState): void {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      logger.debug(`Conversation state: ${prev} → ${state}`);
      this.emit('stateChange', state);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
