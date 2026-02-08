import { VoiceConnection } from '@discordjs/voice';
import type { VoiceBasedChannel, GuildMember } from 'discord.js';
import { promises as fs } from 'node:fs';
import { config, isUserAllowed } from '../config.js';
import { logger } from '../utils/logger.js';
import { cleanupAudioFiles } from '../utils/audio.js';
import { voiceRecorder, voicePlayer } from '../voice/index.js';
import type { RecordingResult } from '../voice/index.js';
import type { STTProvider } from '../providers/stt/index.js';
import type { TTSProvider } from '../providers/tts/index.js';
import type { WakeWordProvider } from '../providers/wakeword/index.js';
import { ConversationService } from './conversation.js';
import { OpenClawBridgeService } from './openclaw-bridge.js';
import type { TextBridgeService } from './text-bridge.js';
import { ResponseQueue, type QueuedResponse } from './response-queue.js';

export type VoiceMode = 'normal' | 'silent' | 'free';

interface UserSession {
  userId: string;
  username: string;
  isProcessing: boolean;
  lastActivity: number;
}

interface GuildState {
  connection: VoiceConnection;
  channel: VoiceBasedChannel;
  mode: VoiceMode;
  guildOwnerId: string;
  userSessions: Map<string, UserSession>;
  responseQueue: ResponseQueue;
}

/**
 * Multi-User Voice Assistant
 * Handles multiple users speaking simultaneously with per-user conversation contexts,
 * response queuing, and interrupt handling.
 */
export class VoiceAssistantMulti {
  private sttProvider: STTProvider;
  private ttsProvider: TTSProvider;
  private wakeWordProvider: WakeWordProvider | null;
  private conversationService: ConversationService;
  private openclawBridge: OpenClawBridgeService | null;
  private textBridge: TextBridgeService | null;
  private guildStates: Map<string, GuildState> = new Map();
  private ignorePhrases = ['Thank you.', 'Bye.', 'Thanks for watching.'];

  constructor(
    sttProvider: STTProvider,
    ttsProvider: TTSProvider,
    conversationService: ConversationService,
    wakeWordProvider: WakeWordProvider | null = null,
    openclawBridge: OpenClawBridgeService | null = null,
    textBridge: TextBridgeService | null = null
  ) {
    this.sttProvider = sttProvider;
    this.ttsProvider = ttsProvider;
    this.wakeWordProvider = wakeWordProvider;
    this.conversationService = conversationService;
    this.openclawBridge = openclawBridge;
    this.textBridge = textBridge;

    // Set up TTS provider for voice player
    voicePlayer.setTTSProvider(this.ttsProvider);

    // Set up recording callback
    voiceRecorder.onRecordingComplete((result) => {
      this.handleRecording(result).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Recording handler error: ${message}`);
      });
    });
  }

  /**
   * Start voice assistant for a channel
   */
  start(connection: VoiceConnection, channel: VoiceBasedChannel, mode: VoiceMode = 'normal'): void {
    const guildId = channel.guild.id;
    const guildOwnerId = channel.guild.ownerId;

    const responseQueue = new ResponseQueue();

    // Set up response queue handlers
    responseQueue.on('ready', () => {
      this.processNextResponse(guildId).catch((error) => {
        logger.error(`Response queue processing error: ${error}`);
      });
    });

    // Set up interrupt handler
    responseQueue.onInterrupt(() => {
      voicePlayer.stop();
      logger.debug(`Response interrupted`, { guildId });
    });

    this.guildStates.set(guildId, {
      connection,
      channel,
      mode,
      guildOwnerId,
      userSessions: new Map(),
      responseQueue,
    });

    voicePlayer.setConnection(connection);

    // Start recording for all allowed members in the channel
    const memberIds = this.getChannelMemberIds(channel, guildOwnerId);
    voiceRecorder.startRecordingAll(connection, memberIds);

    // Initialize user sessions
    for (const [memberId, member] of channel.members) {
      if (!member.user.bot && isUserAllowed(memberId, guildOwnerId)) {
        this.createUserSession(guildId, memberId, member.displayName);
      }
    }

    const wakeWordStatus = this.wakeWordProvider
      ? `enabled (${this.wakeWordProvider.name})`
      : 'disabled (trigger word fallback)';

    logger.info(`Multi-user voice assistant started in ${channel.name}`, {
      guildId,
      mode,
      userCount: memberIds.length,
      wakeWord: wakeWordStatus,
    });
  }

  /**
   * Stop voice assistant for a guild
   */
  stop(guildId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    voiceRecorder.stopAll();
    voicePlayer.stop();
    state.responseQueue.cancelAll();
    this.conversationService.cancelAll();
    this.guildStates.delete(guildId);

    logger.info(`Multi-user voice assistant stopped`, { guildId });
  }

  /**
   * Handle a new user joining the voice channel
   */
  handleUserJoin(guildId: string, userId: string, member?: GuildMember): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    // Check if user is allowed
    if (!isUserAllowed(userId, state.guildOwnerId)) {
      logger.debug(`User ${userId} not allowed, skipping recording`);
      return;
    }

    const username = member?.displayName ?? userId;
    this.createUserSession(guildId, userId, username);

    logger.info(`User joined voice channel`, { guildId, userId, username });
    voiceRecorder.startRecording(state.connection, userId);
  }

  /**
   * Handle a user leaving the voice channel
   */
  handleUserLeave(guildId: string, userId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    logger.info(`User left voice channel`, { guildId, userId });
    
    voiceRecorder.stopRecording(userId);
    this.conversationService.cancel(userId);
    state.responseQueue.cancelUser(userId);
    state.userSessions.delete(userId);
  }

  /**
   * Interrupt current processing (stop command)
   */
  interrupt(guildId: string, userId?: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    if (userId) {
      // Interrupt specific user
      state.responseQueue.cancelUser(userId);
      this.conversationService.cancel(userId);
      const session = state.userSessions.get(userId);
      if (session) {
        session.isProcessing = false;
      }
      logger.info(`Interrupted user ${userId}`, { guildId });
    } else {
      // Interrupt all
      voicePlayer.stop();
      state.responseQueue.cancelAll();
      this.conversationService.cancelAll();
      for (const session of state.userSessions.values()) {
        session.isProcessing = false;
      }
      logger.info(`Interrupted all users`, { guildId });
    }
  }

  /**
   * Check if a user is currently processing
   */
  isUserProcessing(guildId: string, userId: string): boolean {
    const state = this.guildStates.get(guildId);
    if (!state) return false;

    const session = state.userSessions.get(userId);
    return session?.isProcessing ?? false;
  }

  /**
   * Get current mode for a guild
   */
  getMode(guildId: string): VoiceMode | undefined {
    return this.guildStates.get(guildId)?.mode;
  }

  /**
   * Create or update a user session
   */
  private createUserSession(guildId: string, userId: string, username: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    state.userSessions.set(userId, {
      userId,
      username,
      isProcessing: false,
      lastActivity: Date.now(),
    });

    this.conversationService.setUsername(userId, username);

    logger.debug(`Created user session`, { guildId, userId, username });
  }

  /**
   * Process the next queued response
   */
  private async processNextResponse(guildId: string): Promise<void> {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    // Don't start if already playing
    if (state.responseQueue.playing || voicePlayer.playing) {
      return;
    }

    const response = state.responseQueue.dequeue();
    if (!response) return;

    state.responseQueue.setPlaying(true);

    try {
      logger.info(`Playing response for user ${response.username}`, {
        guildId,
        userId: response.userId,
        textLength: response.text.length,
      });

      // Play result sound
      if (state.mode !== 'silent') {
        await voicePlayer.playSound('result');
      }

      // Speak the response
      await voicePlayer.speak(response.text);

      logger.debug(`Response playback complete for user ${response.username}`, {
        guildId,
        userId: response.userId,
      });
    } catch (error) {
      logger.error(`Response playback error: ${error}`, {
        guildId,
        userId: response.userId,
      });
    } finally {
      state.responseQueue.markComplete();
    }
  }

  /**
   * Handle a recording completion
   */
  private async handleRecording(result: RecordingResult): Promise<void> {
    const { userId, mp3Path, pcmPath, duration } = result;

    // Find the guild state for this user
    let guildState: GuildState | undefined;
    let guildId: string | undefined;

    for (const [id, state] of this.guildStates) {
      if (state.userSessions.has(userId)) {
        guildState = state;
        guildId = id;
        break;
      }
    }

    if (!guildState || !guildId) {
      logger.warn(`No guild state found for user ${userId}`);
      await cleanupAudioFiles(userId);
      return;
    }

    const session = guildState.userSessions.get(userId);
    if (!session) {
      logger.warn(`No user session found for user ${userId}`);
      await cleanupAudioFiles(userId);
      return;
    }

    // Check if user is allowed (double-check in case config changed)
    if (!isUserAllowed(userId, guildState.guildOwnerId)) {
      logger.debug(`User ${userId} not allowed, ignoring recording`);
      await cleanupAudioFiles(userId);
      return;
    }

    // If user is already processing, this is a new interrupt/request
    if (session.isProcessing) {
      logger.info(`User ${userId} interrupted their own request`, { guildId });
      // Cancel previous request
      this.conversationService.cancel(userId);
      guildState.responseQueue.cancelUser(userId);
    }

    // If bot is currently speaking to another user, interrupt
    const currentResponse = guildState.responseQueue.getCurrent();
    if (currentResponse && currentResponse.userId !== userId && voicePlayer.playing) {
      logger.info(`User ${userId} interrupted response for user ${currentResponse.userId}`, {
        guildId,
      });
      guildState.responseQueue.cancelAll();
    }

    session.lastActivity = Date.now();

    try {
      const freeMode = guildState.mode === 'free';
      const useWakeWord = this.wakeWordProvider !== null && !freeMode;

      // ── Wake Word Detection (local, before STT) ──
      if (useWakeWord) {
        const wakeWordDetected = await this.checkWakeWord(pcmPath, userId);

        if (!wakeWordDetected) {
          logger.debug(`No wake word detected, skipping transcription`, { userId });
          await cleanupAudioFiles(userId);
          voiceRecorder.restartRecording(guildState.connection, userId);
          return;
        }

        logger.info(`Wake word detected! Proceeding to transcription`, { userId });
      }

      // ── STT Transcription ──
      const transcription = await this.sttProvider.transcribe(mp3Path);
      const durationSeconds = duration / 1000;

      logger.info(`Transcription: "${transcription}"`, {
        userId,
        username: session.username,
        durationSeconds,
      });

      // Clean up audio files
      await cleanupAudioFiles(userId);

      // Check for ignore phrases (background noise, etc.)
      if (this.shouldIgnore(transcription)) {
        logger.debug(`Ignoring transcription`, { userId });
        voiceRecorder.restartRecording(guildState.connection, userId);
        return;
      }

      // Check for stop command
      if (this.isStopCommand(transcription)) {
        await this.playConfirmation(guildState);
        this.interrupt(guildId, userId);
        voiceRecorder.restartRecording(guildState.connection, userId);
        return;
      }

      // ── Trigger word handling ──
      let cleanedText: string;

      if (useWakeWord) {
        // Wake word already confirmed detection — use full transcription
        const stripped = this.stripTriggerWords(transcription);
        cleanedText = stripped || transcription;
      } else {
        // No wake word provider — fall back to trigger word matching in text
        const { triggered, cleanedText: triggerCleaned } = this.checkTrigger(
          transcription,
          freeMode
        );

        if (!triggered) {
          logger.debug(`No trigger word detected`, { userId });
          voiceRecorder.restartRecording(guildState.connection, userId);
          return;
        }

        cleanedText = triggerCleaned;
      }

      // Mark user as processing
      session.isProcessing = true;

      // Play confirmation sound
      await this.playConfirmation(guildState);

      if (this.openclawBridge) {
        // ── OpenClaw Bridge Mode ──
        // Send to OpenClaw (fire-and-forget, response comes via /speak)
        this.openclawBridge.sendTranscription({
          text: cleanedText,
          userId,
          userName: session.username,
          channelId: guildState.channel.id,
          guildId: guildId!,
        }).catch(() => {});

        // Log to text channel (fire-and-forget)
        if (this.textBridge) {
          this.textBridge.log(`🎤 **${session.username}:** ${cleanedText}`).catch(() => {});
        }

        // Not waiting for response — it arrives async via /speak
        session.isProcessing = false;
        voiceRecorder.restartRecording(guildState.connection, userId);
      } else {
        // ── Original TextBridge Mode ──
        const response = await this.conversationService.chat(userId, cleanedText, durationSeconds);

        session.isProcessing = false;

        if (!response) {
          voiceRecorder.restartRecording(guildState.connection, userId);
          return;
        }

        // Queue the response
        const queuedResponse: QueuedResponse = {
          userId,
          username: session.username,
          text: response,
          timestamp: Date.now(),
          priority: 0,
        };

        guildState.responseQueue.enqueue(queuedResponse);
        voiceRecorder.restartRecording(guildState.connection, userId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Voice processing error: ${message}`, { userId, guildId });
      session.isProcessing = false;
      await cleanupAudioFiles(userId);
      voiceRecorder.restartRecording(guildState.connection, userId);
    }
  }

  /**
   * Run local wake word detection on PCM audio file
   */
  private async checkWakeWord(pcmPath: string, userId: string): Promise<boolean> {
    if (!this.wakeWordProvider) return false;

    try {
      const pcmData = await fs.readFile(pcmPath);

      if (pcmData.length === 0) {
        logger.debug(`Empty PCM file, skipping wake word check`, { userId });
        return false;
      }

      const result = await this.wakeWordProvider.detect(pcmData, config.audio.sampleRate);

      logger.debug(
        `Wake word result: detected=${result.detected}, confidence=${result.confidence.toFixed(3)}`,
        { userId }
      );

      return result.detected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Wake word detection error: ${message}`, { userId });
      // On error, fall through to STT (don't silently drop audio)
      return true;
    }
  }

  private shouldIgnore(text: string): boolean {
    const normalized = text.trim().toLowerCase();

    // Ignore very short transcriptions
    if (normalized.length < 2) return true;

    // Ignore common false positives
    return this.ignorePhrases.some((phrase) => normalized.includes(phrase.toLowerCase()));
  }

  private isStopCommand(text: string): boolean {
    const normalized = text.toLowerCase();
    const stopPhrases = ['stop', 'shut up', 'be quiet', 'silence'];
    return stopPhrases.some((phrase) => normalized.includes(phrase));
  }

  /**
   * Check for trigger word in transcription text (legacy/fallback behavior)
   */
  private checkTrigger(
    text: string,
    freeMode: boolean
  ): { triggered: boolean; cleanedText: string } {
    if (freeMode) {
      return { triggered: true, cleanedText: text };
    }

    const normalizedText = text.toLowerCase();

    for (const trigger of config.bot.triggers) {
      const regex = new RegExp(`\\b${trigger}\\b`, 'i');
      if (regex.test(normalizedText)) {
        // Remove trigger from text
        const cleanedText = text.replace(regex, '').trim();
        return { triggered: true, cleanedText };
      }
    }

    return { triggered: false, cleanedText: text };
  }

  /**
   * Strip trigger words from transcription text.
   * Used after wake word detection to clean up the text before sending to LLM.
   */
  private stripTriggerWords(text: string): string {
    let cleaned = text;
    for (const trigger of config.bot.triggers) {
      const regex = new RegExp(`\\b${trigger}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '');
    }
    return cleaned.replace(/\s+/g, ' ').trim();
  }

  private async playConfirmation(state: GuildState): Promise<void> {
    if (state.mode !== 'silent') {
      await voicePlayer.playSound('understood');
    }
  }

  private getChannelMemberIds(channel: VoiceBasedChannel, guildOwnerId: string): string[] {
    return Array.from(channel.members.values())
      .filter((member) => !member.user.bot && isUserAllowed(member.id, guildOwnerId))
      .map((member) => member.id);
  }
}
