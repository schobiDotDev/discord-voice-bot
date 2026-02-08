import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { DiscordBrowser } from './discord-browser.js';
import { AudioBridge } from './audio-bridge.js';
import { createSTTProvider } from '../providers/stt/index.js';
import { createTTSProvider } from '../providers/tts/index.js';
import type { STTProvider } from '../providers/stt/interface.js';
import type { TTSProvider } from '../providers/tts/interface.js';

export interface CallRequest {
  userId: string;
  message: string;
  callbackUrl: string;
  channelId?: string;
}

export interface CallResult {
  callId: string;
  status: 'completed' | 'no_answer' | 'failed';
  transcription?: string;
  duration?: number;
  userId: string;
  channel: string;
  channelId: string;
  error?: string;
}

export interface ActiveCall {
  callId: string;
  userId: string;
  callbackUrl: string;
  channelId: string;
  status: 'connecting' | 'greeting' | 'recording' | 'transcribing' | 'responding';
  startedAt: Date;
}

/**
 * Orchestrates Discord DM voice calls.
 *
 * Coordinates DiscordBrowser (CDP), AudioBridge (BlackHole), STT, and TTS
 * to execute a full call lifecycle: connect → greet → record → transcribe → callback.
 *
 * Only one call at a time (BlackHole is a system-wide resource).
 */
export class DmCallService {
  private activeCall: ActiveCall | null = null;
  private browser: DiscordBrowser;
  private audio: AudioBridge;
  private sttProvider: STTProvider;
  private ttsProvider: TTSProvider;
  private completedCalls: Map<string, CallResult> = new Map();

  constructor() {
    this.browser = new DiscordBrowser();
    this.audio = new AudioBridge();
    this.sttProvider = createSTTProvider();
    this.ttsProvider = createTTSProvider();
  }

  get busy(): boolean {
    return this.activeCall !== null;
  }

  get currentCall(): ActiveCall | null {
    return this.activeCall;
  }

  getCallResult(callId: string): CallResult | undefined {
    return this.completedCalls.get(callId);
  }

  /**
   * Start a DM call. Returns callId immediately.
   * Call runs in background, result delivered to callbackUrl.
   */
  startCall(request: CallRequest): string {
    if (this.activeCall) {
      throw new Error('A call is already in progress');
    }

    const callId = `call_${randomUUID().substring(0, 8)}`;
    this.activeCall = {
      callId,
      userId: request.userId,
      callbackUrl: request.callbackUrl,
      channelId: request.channelId ?? 'dm-call',
      status: 'connecting',
      startedAt: new Date(),
    };

    // Run call flow in background — don't await
    this.executeCall(callId, request).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Call ${callId} unhandled error: ${msg}`);
    });

    return callId;
  }

  private async executeCall(callId: string, request: CallRequest): Promise<void> {
    const result: CallResult = {
      callId,
      status: 'failed',
      userId: request.userId,
      channel: 'discord-voice',
      channelId: request.channelId ?? 'dm-call',
    };

    try {
      // Phase 0: Prepare audio routing
      this.audio.prepareForCall();

      // Phase 1: Connect
      this.updateStatus(callId, 'connecting');
      await this.browser.connect();
      await this.browser.navigateToDM(request.userId);
      await this.browser.startCall();

      const connected = await this.browser.waitForConnection();
      if (!connected) {
        result.status = 'no_answer';
        await this.browser.hangup().catch(() => {});
        await this.sendCallback(request.callbackUrl, result);
        return;
      }

      await this.browser.ensureUnmuted();
      await sleep(4000); // Wait for Discord audio pipeline to stabilize

      // Phase 2: Greeting
      this.updateStatus(callId, 'greeting');
      const ttsAudio = await this.ttsProvider.synthesize(request.message);
      await this.audio.playToDiscord(ttsAudio);
      await sleep(1000); // Pause after speaking before recording

      // Phase 3: Record with silence detection
      this.updateStatus(callId, 'recording');
      const audioFile = await this.recordWithSilenceDetection();

      // Phase 4: Transcribe (still connected!)
      this.updateStatus(callId, 'transcribing');
      const transcription = await this.sttProvider.transcribe(audioFile, config.language);
      // Keep recording for debugging — don't cleanup
      logger.info(`Recording kept: ${audioFile}`);

      // Phase 5: Respond via TTS if we got real speech
      if (transcription && !isWhisperHallucination(transcription)) {
        this.updateStatus(callId, 'responding');
        const responseText = `Du hast gesagt: ${transcription}`;
        const responseTts = await this.ttsProvider.synthesize(responseText);
        await this.audio.playToDiscord(responseTts);
        await sleep(3000); // Let user hear the full response
      }

      // Phase 6: Hang up
      await this.browser.hangup();
      this.audio.restoreAudio();

      result.status = 'completed';
      result.transcription = transcription;
      result.duration = (Date.now() - this.activeCall!.startedAt.getTime()) / 1000;

      logger.info(`Call ${callId} completed`, {
        duration: result.duration,
        transcription: transcription.substring(0, 100),
      });

      await this.sendCallback(request.callbackUrl, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Call ${callId} error: ${msg}`);
      result.status = 'failed';
      result.error = msg;

      try { await this.browser.hangup(); } catch {}
      this.audio.restoreAudio();
      this.browser.disconnect();

      await this.sendCallback(request.callbackUrl, result);
    } finally {
      this.completedCalls.set(callId, result);
      this.activeCall = null;
      this.browser.disconnect();
    }
  }

  /**
   * Record audio with ffmpeg silencedetect filter.
   *
   * Starts recording and monitors stderr for silence events.
   * Stops when silence is detected after speech, or on max timeout.
   */
  private recordWithSilenceDetection(): Promise<string> {
    return new Promise(async (resolve, reject) => {
      const outFile = `${process.cwd()}/recordings/response-${Date.now()}.wav`;
      const silenceThreshold = '-30dB';
      const silenceDuration = config.dmCall.silenceTimeout;
      const maxDuration = config.dmCall.timeout;

      // Use ffmpeg with silencedetect filter
      // This records audio AND detects silence in one pass
      const proc = spawn('ffmpeg', [
        '-y',
        '-f', 'avfoundation',
        '-i', `:${await this.getRecordDeviceIndex()}`,
        '-af', `silencedetect=noise=${silenceThreshold}:d=${silenceDuration}`,
        '-ar', '16000',
        '-ac', '1',
        '-t', String(maxDuration),
        outFile,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let speechDetected = false;
      let silenceAfterSpeech = false;
      let stderrBuffer = '';

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrBuffer += text;

        // silence_end means speech just started
        if (text.includes('silence_end')) {
          speechDetected = true;
          logger.debug('Speech detected');
        }

        // silence_start after speech means user stopped talking
        if (speechDetected && text.includes('silence_start')) {
          silenceAfterSpeech = true;
          logger.info('Silence after speech detected — stopping recording');
          // Give a tiny buffer then stop
          setTimeout(() => {
            proc.kill('SIGTERM');
          }, 300);
        }
      });

      proc.on('close', (code) => {
        if (silenceAfterSpeech || code === 0) {
          logger.debug(`Recording complete (speech: ${speechDetected}, silence-stop: ${silenceAfterSpeech})`);
          resolve(outFile);
        } else if (!speechDetected) {
          // No speech at all — max timeout or killed
          logger.warn('No speech detected during recording');
          resolve(outFile);
        } else {
          reject(new Error(`ffmpeg recording failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`ffmpeg recording error: ${err.message}`));
      });
    });
  }

  /**
   * Get the avfoundation device index for recording.
   * Uses the same detection as AudioBridge.
   */
  private async getRecordDeviceIndex(): Promise<number> {
    const { execSync } = await import('node:child_process');
    const device = config.dmCall.blackholeOutput;

    let output: string;
    try {
      output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', {
        encoding: 'utf-8',
      });
    } catch (err: unknown) {
      output = (err as { stdout?: string; stderr?: string }).stdout
        ?? (err as { stderr?: string }).stderr
        ?? '';
    }

    const lines = output.split('\n');
    let inAudio = false;

    for (const line of lines) {
      if (line.includes('AVFoundation audio devices')) {
        inAudio = true;
        continue;
      }
      if (!inAudio) continue;

      const match = line.match(/\[(\d+)\]\s+(.+)/);
      if (match && match[2].includes(device)) {
        return parseInt(match[1], 10);
      }
    }

    throw new Error(`Audio device not found: ${device}`);
  }

  private updateStatus(callId: string, status: ActiveCall['status']): void {
    if (this.activeCall?.callId === callId) {
      this.activeCall.status = status;
      logger.debug(`Call ${callId} → ${status}`);
    }
  }

  private async sendCallback(url: string, result: CallResult): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });

        if (res.ok) {
          logger.info(`Callback sent to ${url}`, { callId: result.callId, status: result.status });
          return;
        }

        logger.error(`Callback failed (attempt ${attempt + 1}): ${res.status} ${res.statusText}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Callback request failed (attempt ${attempt + 1}): ${msg}`);
      }

      if (attempt === 0) await sleep(2000);
    }
  }

  async dispose(): Promise<void> {
    if (this.activeCall) {
      try { await this.browser.hangup(); } catch {}
      this.audio.restoreAudio();
    }
    this.browser.disconnect();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

const WHISPER_HALLUCINATIONS = [
  'untertitel der amara.org',
  'amara.org-community',
  'thank you for watching',
  'thanks for watching',
];

function isWhisperHallucination(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return WHISPER_HALLUCINATIONS.some(h => lower.includes(h));
}
