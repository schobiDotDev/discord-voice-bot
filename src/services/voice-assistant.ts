import { VoiceConnection } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { cleanupAudioFiles } from '../utils/audio.js';
import { voiceRecorder, voicePlayer } from '../voice/index.js';
import type { RecordingResult } from '../voice/index.js';
import type { STTProvider } from '../providers/stt/index.js';
import type { TTSProvider } from '../providers/tts/index.js';
import { ConversationService } from './conversation.js';

export type VoiceMode = 'normal' | 'silent' | 'free';

interface GuildState {
  connection: VoiceConnection;
  channel: VoiceBasedChannel;
  mode: VoiceMode;
  isProcessing: boolean;
}

/**
 * Voice Assistant orchestrates the full voice interaction flow:
 * Recording -> STT -> LLM -> TTS -> Playback
 */
export class VoiceAssistant {
  private sttProvider: STTProvider;
  private ttsProvider: TTSProvider;
  private conversationService: ConversationService;
  private guildStates: Map<string, GuildState> = new Map();
  private ignorePhrases = ['Thank you.', 'Bye.', 'Thanks for watching.'];

  constructor(
    sttProvider: STTProvider,
    ttsProvider: TTSProvider,
    conversationService: ConversationService
  ) {
    this.sttProvider = sttProvider;
    this.ttsProvider = ttsProvider;
    this.conversationService = conversationService;

    // Set up TTS provider for voice player
    voicePlayer.setTTSProvider(this.ttsProvider);

    // Set up recording callback
    voiceRecorder.onRecordingComplete(this.handleRecording.bind(this));
  }

  /**
   * Start voice assistant for a channel
   */
  async start(
    connection: VoiceConnection,
    channel: VoiceBasedChannel,
    mode: VoiceMode = 'normal'
  ): Promise<void> {
    const guildId = channel.guild.id;

    this.guildStates.set(guildId, {
      connection,
      channel,
      mode,
      isProcessing: false,
    });

    voicePlayer.setConnection(connection);

    // Start recording for all members in the channel
    const memberIds = this.getChannelMemberIds(channel);
    voiceRecorder.startRecordingAll(connection, memberIds);

    logger.info(`Voice assistant started in ${channel.name}`, {
      guildId,
      mode,
      memberCount: memberIds.length,
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
    this.guildStates.delete(guildId);

    logger.info(`Voice assistant stopped`, { guildId });
  }

  /**
   * Handle a new user joining the voice channel
   */
  handleUserJoin(guildId: string, userId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    logger.info(`User joined voice channel`, { guildId, userId });
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
  }

  /**
   * Interrupt current processing (stop command)
   */
  interrupt(guildId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    voicePlayer.stop();
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
    const { userId, mp3Path, duration } = result;

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

    // Skip if already processing
    if (guildState.isProcessing) {
      logger.debug(`Already processing, restarting recording`, { userId });
      await cleanupAudioFiles(userId);
      voiceRecorder.restartRecording(guildState.connection, userId);
      return;
    }

    try {
      // Transcribe audio
      const transcription = await this.sttProvider.transcribe(mp3Path);

      logger.info(`Transcription: "${transcription}"`, { userId, duration });

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

      // Check for trigger word (unless in free mode)
      const freeMode = guildState.mode === 'free';
      const { triggered, cleanedText } = this.checkTrigger(transcription, freeMode);

      if (!triggered) {
        logger.debug(`No trigger word detected`, { userId });
        voiceRecorder.restartRecording(guildState.connection, userId);
        return;
      }

      // Check for built-in commands
      const handled = await this.handleBuiltInCommands(cleanedText, guildId, userId, guildState);
      if (handled) {
        voiceRecorder.restartRecording(guildState.connection, userId);
        return;
      }

      // Process with LLM
      guildState.isProcessing = true;

      // Play confirmation sound
      await this.playConfirmation(guildState);

      // Get LLM response
      const response = await this.conversationService.chat(userId, cleanedText, freeMode);

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
      logger.error(`Voice processing error: ${error}`, { userId });
      guildState.isProcessing = false;
      await cleanupAudioFiles(userId);
      voiceRecorder.restartRecording(guildState.connection, userId);
    }
  }

  private shouldIgnore(text: string): boolean {
    const normalized = text.trim().toLowerCase();

    // Ignore very short transcriptions
    if (normalized.length < 2) return true;

    // Ignore common false positives
    return this.ignorePhrases.some((phrase) =>
      normalized.includes(phrase.toLowerCase())
    );
  }

  private isStopCommand(text: string): boolean {
    const normalized = text.toLowerCase();
    const stopPhrases = ['stop', 'shut up', 'be quiet', 'silence'];
    return stopPhrases.some((phrase) => normalized.includes(phrase));
  }

  private checkTrigger(text: string, freeMode: boolean): { triggered: boolean; cleanedText: string } {
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

  private async handleBuiltInCommands(
    text: string,
    _guildId: string,
    userId: string,
    state: GuildState
  ): Promise<boolean> {
    const normalized = text.toLowerCase().replace(/[.,!?]/g, '');

    // Reset chat history
    if (normalized.includes('reset') && normalized.includes('chat') && normalized.includes('history')) {
      await this.playConfirmation(state);
      this.conversationService.reset(userId);
      return true;
    }

    // Leave voice chat
    if (normalized.includes('leave') && normalized.includes('voice') && normalized.includes('chat')) {
      await this.playConfirmation(state);
      // This will be handled by the command layer
      return false;
    }

    return false;
  }

  private async playConfirmation(state: GuildState): Promise<void> {
    if (state.mode !== 'silent') {
      await voicePlayer.playSound('understood');
    }
  }

  private getChannelMemberIds(channel: VoiceBasedChannel): string[] {
    return Array.from(channel.members.values())
      .filter((member) => !member.user.bot)
      .map((member) => member.id);
  }
}
