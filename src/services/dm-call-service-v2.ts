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
  dmChannelId: string;
  message: string;
  callbackUrl: string;
  channelId?: string;
  maxTurns?: number;
  agentResponseTimeout?: number;
  keepRecordings?: boolean;
}

export interface AgentResponse {
  text?: string;
  hangup?: boolean;
}

export interface CallbackPayload {
  type: 'transcription' | 'call_ended';
  callId: string;
  userId: string;
  channel: string;
  channelId: string;
  // transcription callback fields
  transcription?: string;
  turnCount?: number;
  isSilence?: boolean;
  // call_ended callback fields
  status?: 'completed' | 'no_answer' | 'failed' | 'timeout' | 'max_turns';
  duration?: number;
  totalTurns?: number;
  error?: string;
}

export interface ActiveCall {
  callId: string;
  userId: string;
  callbackUrl: string;
  channelId: string;
  status: 'connecting' | 'greeting' | 'recording' | 'transcribing' | 'waiting_for_agent' | 'responding' | 'disconnecting';
  startedAt: Date;
  turnCount: number;
  maxTurns: number;
  agentResponseTimeout: number;
  keepRecordings: boolean;
  responseResolver: ((response: AgentResponse) => void) | null;
}

/**
 * Orchestrates Discord DM voice calls with multi-turn conversation.
 *
 * Coordinates DiscordBrowser (CDP), AudioBridge (BlackHole), STT, and TTS
 * to run a conversation loop: connect → greet → [record → transcribe → callback → wait → respond → repeat] → hangup.
 *
 * Only one call at a time (BlackHole is a system-wide resource).
 */
export class DmCallService {
  private activeCall: ActiveCall | null = null;
  private browser: DiscordBrowser;
  private audio: AudioBridge;
  private sttProvider: STTProvider;
  private ttsProvider: TTSProvider;
  private completedCalls: Map<string, CallbackPayload> = new Map();

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

  getCallResult(callId: string): CallbackPayload | undefined {
    return this.completedCalls.get(callId);
  }

  /**
   * Start a DM call. Returns callId immediately.
   * Call runs in background with conversation loop.
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
      turnCount: 0,
      maxTurns: request.maxTurns ?? 10,
      agentResponseTimeout: request.agentResponseTimeout ?? 30000,
      keepRecordings: request.keepRecordings ?? false,
      responseResolver: null,
    };

    this.executeConversationLoop(callId, request).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Call ${callId} unhandled error: ${msg}`);
    });

    return callId;
  }

  /**
   * Send a response to an active call that's waiting for agent input.
   * Returns true if the response was accepted.
   */
  respondToCall(callId: string, response: AgentResponse): boolean {
    if (!this.activeCall || this.activeCall.callId !== callId) {
      return false;
    }

    if (!this.activeCall.responseResolver) {
      return false;
    }

    this.activeCall.responseResolver(response);
    this.activeCall.responseResolver = null;
    return true;
  }

  /**
   * Force-hangup an active call.
   */
  hangupCall(callId: string): boolean {
    if (!this.activeCall || this.activeCall.callId !== callId) {
      return false;
    }

    // If waiting for agent, resolve with hangup
    if (this.activeCall.responseResolver) {
      this.activeCall.responseResolver({ hangup: true });
      this.activeCall.responseResolver = null;
      return true;
    }

    // Otherwise set status so the loop breaks on next iteration
    this.activeCall.status = 'disconnecting';
    return true;
  }

  private async executeConversationLoop(callId: string, request: CallRequest): Promise<void> {
    let endStatus: CallbackPayload['status'] = 'failed';
    let endError: string | undefined;

    try {
      // Phase 0: Prepare audio routing
      this.audio.prepareForCall();

      // Phase 1: Connect
      this.updateStatus(callId, 'connecting');
      await this.browser.connect();
      await this.browser.navigateToDM(request.dmChannelId);
      await this.browser.startCall();

      const connected = await this.browser.waitForConnection();
      if (!connected) {
        endStatus = 'no_answer';
        await this.browser.hangup().catch(() => {});
        return;
      }

      await this.browser.ensureUnmuted();
      await sleep(4000); // Wait for Discord audio pipeline to stabilize

      // Phase 2: Greeting
      this.updateStatus(callId, 'greeting');
      const ttsAudio = await this.ttsProvider.synthesize(request.message);
      await this.audio.playToDiscord(ttsAudio);
      await sleep(1000);

      // Phase 3: Conversation loop
      let consecutiveSilence = 0;

      while (this.activeCall?.callId === callId && this.activeCall.status !== 'disconnecting') {
        const call = this.activeCall;

        // Check max turns
        if (call.turnCount >= call.maxTurns) {
          logger.info(`Call ${callId} reached max turns (${call.maxTurns})`);
          endStatus = 'max_turns';
          await this.playGoodbye('Die maximale Gesprächsdauer wurde erreicht. Auf Wiedersehen!');
          break;
        }

        // Record (with one retry on audio device error)
        this.updateStatus(callId, 'recording');
        let audioFile: string;
        try {
          audioFile = await this.recordWithSilenceDetection();
        } catch (recordErr) {
          logger.warn(`Recording failed, invalidating device cache and retrying: ${recordErr}`);
          this.audio.invalidateDeviceCache();
          audioFile = await this.recordWithSilenceDetection();
        }

        // Transcribe
        this.updateStatus(callId, 'transcribing');
        const transcription = await this.sttProvider.transcribe(audioFile, config.language);

        if (!call.keepRecordings) {
          this.audio.cleanup(audioFile);
        } else {
          logger.info(`Recording kept: ${audioFile}`);
        }

        call.turnCount++;
        const isSilence = !transcription || isWhisperHallucination(transcription);

        if (isSilence) {
          consecutiveSilence++;
          logger.debug(`Silent turn ${consecutiveSilence} (turn ${call.turnCount})`);
        } else {
          consecutiveSilence = 0;
          logger.info(`Turn ${call.turnCount}: "${transcription.substring(0, 80)}"`);
        }

        // Send transcription callback to agent
        await this.sendCallback(call.callbackUrl, {
          type: 'transcription',
          callId,
          userId: call.userId,
          channel: 'voice-call',
          channelId: call.channelId,
          transcription: isSilence ? '' : transcription,
          turnCount: call.turnCount,
          isSilence,
        });

        // Wait for agent response
        this.updateStatus(callId, 'waiting_for_agent');
        const agentResponse = await this.waitForAgentResponse(callId, call.agentResponseTimeout);

        if (!agentResponse) {
          // Timeout — agent didn't respond
          logger.warn(`Call ${callId} agent response timeout`);
          endStatus = 'timeout';
          await this.playGoodbye('Auf Wiedersehen!');
          break;
        }

        if (agentResponse.hangup) {
          endStatus = 'completed';
          if (agentResponse.text) {
            await this.playGoodbye(agentResponse.text);
          }
          break;
        }

        // Play agent's response via TTS
        if (agentResponse.text) {
          this.updateStatus(callId, 'responding');
          const responseTts = await this.ttsProvider.synthesize(agentResponse.text);
          try {
            await this.audio.playToDiscord(responseTts);
          } catch (playErr) {
            logger.warn(`Playback failed, invalidating device cache and retrying: ${playErr}`);
            this.audio.invalidateDeviceCache();
            await this.audio.playToDiscord(responseTts);
          }
          await sleep(500);
        }

        // Loop continues → record next turn
      }

      if (endStatus === 'failed') {
        // Normal exit without explicit status means completed
        endStatus = 'completed';
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Call ${callId} error: ${msg}`);
      endStatus = 'failed';
      endError = msg;

      try { await this.browser.hangup(); } catch {}
      this.audio.restoreAudio();
      this.browser.disconnect();
    } finally {
      // Ensure cleanup
      try { await this.browser.hangup(); } catch {}
      this.audio.restoreAudio();
      this.browser.disconnect();

      const duration = this.activeCall
        ? (Date.now() - this.activeCall.startedAt.getTime()) / 1000
        : 0;

      const endPayload: CallbackPayload = {
        type: 'call_ended',
        callId,
        userId: request.userId,
        channel: 'voice-call',
        channelId: request.channelId ?? 'dm-call',
        status: endStatus,
        duration,
        totalTurns: this.activeCall?.turnCount ?? 0,
        error: endError,
      };

      logger.info(`Call ${callId} ended: ${endStatus}`, { duration, turns: endPayload.totalTurns });

      this.completedCalls.set(callId, endPayload);
      this.activeCall = null;

      await this.sendCallback(request.callbackUrl, endPayload);
    }
  }

  /**
   * Wait for the agent to respond via respondToCall().
   * Returns null on timeout.
   */
  private waitForAgentResponse(callId: string, timeoutMs: number): Promise<AgentResponse | null> {
    return new Promise((resolve) => {
      if (!this.activeCall || this.activeCall.callId !== callId) {
        resolve(null);
        return;
      }

      const timer = setTimeout(() => {
        if (this.activeCall?.responseResolver) {
          this.activeCall.responseResolver = null;
        }
        resolve(null);
      }, timeoutMs);

      this.activeCall.responseResolver = (response: AgentResponse) => {
        clearTimeout(timer);
        resolve(response);
      };
    });
  }

  /**
   * Play a goodbye message via TTS, then disconnect.
   */
  private async playGoodbye(text: string): Promise<void> {
    try {
      this.updateStatus(this.activeCall!.callId, 'disconnecting');
      const ttsAudio = await this.ttsProvider.synthesize(text);
      await this.audio.playToDiscord(ttsAudio);
      await sleep(1500);
    } catch (error) {
      logger.warn(`Goodbye TTS failed: ${error instanceof Error ? error.message : error}`);
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

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();

        if (text.includes('silence_end')) {
          speechDetected = true;
          logger.debug('Speech detected');
        }

        if (speechDetected && text.includes('silence_start')) {
          silenceAfterSpeech = true;
          logger.info('Silence after speech — stopping recording');
          setTimeout(() => proc.kill('SIGTERM'), 300);
        }
      });

      proc.on('close', (code) => {
        if (silenceAfterSpeech || code === 0) {
          resolve(outFile);
        } else if (!speechDetected) {
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

  private async sendCallback(url: string, payload: CallbackPayload): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          logger.info(`Callback sent (${payload.type})`, { callId: payload.callId });
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
      // Resolve any pending waiter so the loop can exit
      if (this.activeCall.responseResolver) {
        this.activeCall.responseResolver({ hangup: true });
      }
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
