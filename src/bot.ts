import {
  Client,
  GatewayIntentBits,
  Events,
  VoiceState,
} from 'discord.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { ensureDirectories, cleanupAllRecordings } from './utils/audio.js';
import { voiceConnectionManager } from './voice/index.js';
import { createSTTProvider } from './providers/stt/index.js';
import { createLLMProvider } from './providers/llm/index.js';
import { createTTSProvider } from './providers/tts/index.js';
import { ConversationService, VoiceAssistant } from './services/index.js';
import { registerCommands, handleCommand, type CommandContext } from './commands/index.js';

/**
 * Discord Voice Bot
 */
export class Bot {
  private client: Client;
  private voiceAssistant: VoiceAssistant;
  private conversationService: ConversationService;
  private isReady = false;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Initialize providers
    const sttProvider = createSTTProvider();
    const llmProvider = createLLMProvider();
    const ttsProvider = createTTSProvider();

    // Initialize services
    this.conversationService = new ConversationService(llmProvider);
    this.voiceAssistant = new VoiceAssistant(
      sttProvider,
      ttsProvider,
      this.conversationService
    );

    this.setupEventHandlers();
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    // Ensure directories exist
    await ensureDirectories();

    // Clean up old recordings
    await cleanupAllRecordings();

    // Register slash commands
    await registerCommands();

    // Login to Discord
    logger.info('Logging in to Discord...');
    await this.client.login(config.discord.token);
  }

  /**
   * Stop the bot gracefully
   */
  async stop(): Promise<void> {
    logger.info('Shutting down...');

    // Destroy all voice connections
    voiceConnectionManager.destroyAll();

    // Destroy client
    this.client.destroy();

    // Clean up recordings
    await cleanupAllRecordings();

    logger.info('Shutdown complete');
  }

  private setupEventHandlers(): void {
    const commandContext: CommandContext = {
      voiceAssistant: this.voiceAssistant,
      conversationService: this.conversationService,
    };

    // Ready event
    this.client.once(Events.ClientReady, (client) => {
      logger.info(`Logged in as ${client.user.tag}`);
      this.isReady = true;
    });

    // Slash command handling
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await handleCommand(interaction, commandContext);
    });

    // Voice state updates (user join/leave)
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState);
    });

    // Error handling
    this.client.on(Events.Error, (error) => {
      logger.error(`Discord client error: ${error.message}`);
    });

    this.client.on(Events.Warn, (message) => {
      logger.warn(`Discord client warning: ${message}`);
    });
  }

  private handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    // Ignore bot users
    if (newState.member?.user.bot) return;

    const userId = newState.id;
    const guildId = newState.guild.id;

    // Check if we're connected to this guild
    if (!voiceConnectionManager.isConnected(guildId)) return;

    const connection = voiceConnectionManager.get(guildId);
    if (!connection) return;

    const ourChannelId = connection.joinConfig.channelId;

    // User joined our channel
    if (newState.channelId === ourChannelId && oldState.channelId !== ourChannelId) {
      this.voiceAssistant.handleUserJoin(guildId, userId);
    }

    // User left our channel
    if (oldState.channelId === ourChannelId && newState.channelId !== ourChannelId) {
      this.voiceAssistant.handleUserLeave(guildId, userId);
    }
  }
}
