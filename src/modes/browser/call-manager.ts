import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import { ConversationLoop, type ConversationConfig, type ConversationState } from './conversation.js';
import type { STTProvider } from '../../providers/stt/interface.js';
import type { TTSProvider } from '../../providers/tts/interface.js';

export interface CallManagerConfig {
  inputDeviceIndex: number;
  outputDevice: string;
  systemDevice: string;
  sampleRate?: number;
  channels?: number;
  chunkSeconds?: number;
  volumeThresholdDb?: number;
  silenceDurationMs?: number;
  minSpeechDurationMs?: number;
  language?: string;
}

export type CallState = 'idle' | 'connected' | 'listening' | 'processing' | 'speaking';

/**
 * Manages voice call state and conversation
 * Simplified version that only handles audio (no browser automation)
 * Browser/Discord is managed externally
 */
export class CallManager extends EventEmitter {
  private conversation: ConversationLoop;
  private state: CallState = 'idle';
  private responseCallback?: (transcription: string) => Promise<string>;

  constructor(
    sttProvider: STTProvider,
    ttsProvider: TTSProvider,
    config: CallManagerConfig
  ) {
    super();

    const conversationConfig: ConversationConfig = {
      inputDeviceIndex: config.inputDeviceIndex,
      outputDevice: config.outputDevice,
      systemDevice: config.systemDevice,
      sampleRate: config.sampleRate ?? 16000,
      channels: config.channels ?? 1,
      chunkSeconds: config.chunkSeconds ?? 3,
      volumeThresholdDb: config.volumeThresholdDb ?? -50,
      silenceDurationMs: config.silenceDurationMs ?? 1500,
      minSpeechDurationMs: config.minSpeechDurationMs ?? 500,
      language: config.language ?? 'de',
    };

    this.conversation = new ConversationLoop(
      conversationConfig,
      sttProvider,
      ttsProvider,
      {
        onTranscription: (text) => this.emit('transcription', text),
        onResponse: (text) => this.emit('response', text),
      }
    );

    // Forward conversation events
    this.conversation.on('stateChange', (convState: ConversationState) => {
      this.updateStateFromConversation(convState);
    });

    this.conversation.on('error', (error: Error) => {
      this.emit('error', error);
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
    this.responseCallback = callback;
    this.conversation.setResponseCallback(callback);
  }

  /**
   * Start listening for voice input
   * Call this when Discord call is connected (managed externally)
   */
  async startCall(_userId?: string): Promise<boolean> {
    if (this.state !== 'idle') {
      logger.warn(`Cannot start — current state: ${this.state}`);
      return false;
    }

    logger.info('Starting voice session...');
    this.setState('connected');

    if (this.responseCallback) {
      this.conversation.setResponseCallback(this.responseCallback);
    }

    await this.conversation.start();
    logger.info('Voice session active');
    return true;
  }

  /**
   * Answer an incoming call (same as start for this implementation)
   */
  async answerCall(): Promise<boolean> {
    return this.startCall();
  }

  /**
   * Stop listening and end the session
   */
  async hangUp(): Promise<void> {
    if (this.state === 'idle') return;

    logger.info('Ending voice session...');
    await this.conversation.stop();
    this.setState('idle');
    logger.info('Voice session ended');
  }

  /**
   * Speak text via TTS
   */
  async speak(text: string): Promise<void> {
    if (this.state === 'idle') {
      logger.warn('Cannot speak — session not active');
      return;
    }

    await this.conversation.speak(text);
  }

  /**
   * Listen for a single utterance and return transcription
   * Useful for one-shot commands
   */
  async listenOnce(): Promise<string | null> {
    if (this.state === 'idle') {
      logger.warn('Cannot listen — session not active');
      return null;
    }

    return this.conversation.listenOnce();
  }

  /**
   * Start watching for incoming calls
   * No-op in this implementation (browser-managed externally)
   */
  startIncomingCallWatch(): void {
    // No-op: incoming calls are handled by the external browser/Discord
    logger.debug('Incoming call watch not needed (browser-managed externally)');
  }

  /**
   * Stop watching for incoming calls
   * No-op in this implementation
   */
  stopIncomingCallWatch(): void {
    // No-op
  }

  /**
   * Clean up all resources
   */
  async dispose(): Promise<void> {
    await this.hangUp();
  }

  private updateStateFromConversation(convState: ConversationState): void {
    // Map conversation state to call state
    switch (convState) {
      case 'idle':
        // Only set to idle if we're not in a call
        if (this.state !== 'idle' && !this.conversation.isRunning()) {
          this.setState('idle');
        }
        break;
      case 'listening':
        this.setState('listening');
        break;
      case 'processing':
        this.setState('processing');
        break;
      case 'speaking':
        this.setState('speaking');
        break;
    }
  }

  private setState(state: CallState): void {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      logger.info(`Call state: ${prev} → ${state}`);
      this.emit('stateChange', state);
    }
  }
}
