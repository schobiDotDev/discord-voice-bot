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

export type VoiceMode = 'normal' | 'silent' | 'free';

interface GuildState {
  connection: VoiceConnection;
  channel: VoiceBasedChannel;
  mode: VoiceMode;
  isProcessing: boolean;
  guildOwnerId: string;
}

/**
 * Voice Assistant orchestrates the full voice interaction flow:
 * Recording -> Wake Word Detection -> STT -> Text Bridge -> TTS -> Playback
 *
 * When wake word detection is enabled:
 * - normal/silent modes: PCM audio is first checked for wake word locally,
 *   only if detected the audio is sent to Whisper for full transcription.
 * - free mode: skips wake word detection, transcribes everything.
 *
 * When wake word detection is disabled:
 * - Falls back to trigger word matching in the transcription text (original behavior).
 */
export class VoiceAssistant {
  private sttProvider: STTProvider;
  private ttsProvider: TTSProvider;
  private wakeWordProvider: WakeWordProvider | null;
  private conversationService: ConversationService;
  private guildStates: Map<string, GuildState> = new Map();
  private ignorePhrases = ['Thank you.', 'Bye.', 'Thanks for watching.'];

  constructor(
    sttProvider: STTProvider,
    ttsProvider: TTSProvider,
    conversationService: ConversationService,
    wakeWordProvider: WakeWordProvider | null = null
  ) {
    this.sttProvider = sttProvider;
    this.ttsProvider = ttsProvider;
    this.wakeWordProvider = wakeWordProvider;
    this.conversationService = conversationService;

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

    this.guildStates.set(guildId, {
      connection,
      channel,
      mode,
      isProcessing: false,
      guildOwnerId,
    });

    voicePlayer.setConnection(connection);

    // Start recording for all allowed members in the channel
    const memberIds = this.getChannelMemberIds(channel, guildOwnerId);
    voiceRecorder.startRecordingAll(connection, memberIds);

    // Store usernames for members
    for (const [memberId, member] of channel.members) {
      if (!member.user.bot) {
        this.conversationService.setUsername(memberId, member.displayName);
      }
    }

    const wakeWordStatus = this.wakeWordProvider ? `enabled (${this.wakeWordProvider.name})` : 'disabled (trigger word fallback)';

    logger.info(`Voice assistant started in ${channel.name}`, {
      guildId,
      mode,
      memberCount: memberIds.length,
    });
    logger.info(`Wake word detection: ${wakeWordStatus}`);
  }

  /**
   * Stop voice assistant for a guild
   */
  stop(guildId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    voiceRecorder.stopAll();
    voicePlayer.stop();
    this.conversationService.cancelAll();
    this.guildStates.delete(guildId);

    logger.info(`Voice assistant stopped`, { guildId });
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

    logger.info(`User joined voice channel`, { guildId, userId });
    voiceRecorder.startRecording(state.connection, userId);

    // Store username if member info is available
    if (member) {
      this.conversationService.setUsername(userId, member.displayName);
    }
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
  }

  /**
   * Interrupt current processing (stop command)
   */
  interrupt(guildId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    voicePlayer.stop();
    this.conversationService.cancelAll();
    state.isProcessing = false;
    logger.info(`Voice assistant interrupted`, { guildId });
  }

  /**
   * Check if assistant is processing
   */
  isProcessing(guildId: string): boolean {
    return this.guildStates.get(guildId)?.isProcessing ?? false;
  }

  /**
   * Get current mode for a guild
   */
  getMode(guildId: string): VoiceMode | undefined {
    return this.guildStates.get(guildId)?.mode;
  }

  private async handleRecording(result: RecordingResult): Promise<void> {
    const { userId, mp3Path, pcmPath, duration } = result;

    // Find the guild state for this user
    let guildState: GuildState | undefined;
    let guildId: string | undefined;

    for (const [id, state] of this.guildStates) {
      const member = state.channel.members.get(userId);
      if (member) {
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

    // Check if user is allowed (double-check in case config changed)
    if (!isUserAllowed(userId, guildState.guildOwnerId)) {
      logger.debug(`User ${userId} not allowed, ignoring recording`);
      await cleanupAudioFiles(userId);
      return;
    }

    // Skip if already processing
    if (guildState.isProcessing) {
      logger.debug(`Already processing, restarting recording`, { userId });
      await cleanupAudioFiles(userId);
      voiceRecorder.restartRecording(guildState.connection, userId);
      return;
    }

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

      logger.info(`Transcription: "${transcription}"`, { userId, durationSeconds });

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
        if (guildState.isProcessing || voicePlayer.playing) {
          await this.playConfirmation(guildState);
          this.interrupt(guildId);
          voiceRecorder.restartRecording(guildState.connection, userId);
          return;
        }
      }

      // ── Trigger word handling ──
      let cleanedText: string;

      if (useWakeWord) {
        // Wake word already confirmed detection — use full transcription
        // Still strip trigger words from text if they appear (the wake word
        // keyword name might differ from the trigger word in the transcription)
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

      // Mark as processing
      guildState.isProcessing = true;

      // Play confirmation sound
      await this.playConfirmation(guildState);

      // Post to text channel and wait for response (with duration metadata)
      const response = await this.conversationService.chat(userId, cleanedText, durationSeconds);

      if (!response) {
        guildState.isProcessing = false;
        voiceRecorder.restartRecording(guildState.connection, userId);
        return;
      }

      // Play result sound and speak response
      if (guildState.mode !== 'silent') {
        await voicePlayer.playSound('result');
      }

      await voicePlayer.speak(response);

      guildState.isProcessing = false;
      voiceRecorder.restartRecording(guildState.connection, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Voice processing error: ${message}`, { userId });
      guildState.isProcessing = false;
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

      logger.debug(`Wake word result: detected=${result.detected}, confidence=${result.confidence.toFixed(3)}`, {
        userId,
      });

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
