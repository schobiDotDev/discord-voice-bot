import { Client, GatewayIntentBits, Events, VoiceState } from 'discord.js';
import { config } from './config.js';
import logger from './utils/logger.js';
import { ensureDirectories, cleanupAllRecordings } from './utils/audio.js';
import { voiceConnectionManager } from './voice/index.js';
import { createSTTProvider } from './providers/stt/index.js';
import { createTTSProvider } from './providers/tts/index.js';
import { createWakeWordProvider } from './providers/wakeword/index.js';
import { TextBridgeService, ConversationService, VoiceAssistant } from './services/index.js';
import { registerCommands, handleCommand, type CommandContext } from './commands/index.js';

/**
 * Discord Voice Bot
 * Voice-to-text bridge that integrates with external bots for responses
 */
export class Bot {
  private client: Client;
  private textBridge: TextBridgeService;
  private voiceAssistant: VoiceAssistant;
  private conversationService: ConversationService;
  private wakeWordProvider: ReturnType<typeof createWakeWordProvider>;

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
    const ttsProvider = createTTSProvider();
    this.wakeWordProvider = createWakeWordProvider();

    // Initialize text bridge (needs client for Discord message handling)
    this.textBridge = new TextBridgeService(this.client);

    // Initialize services
    this.conversationService = new ConversationService(this.textBridge);
    this.voiceAssistant = new VoiceAssistant(
      sttProvider,
      ttsProvider,
      this.conversationService,
      this.wakeWordProvider
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

    // Initialize wake word provider (loads ONNX models)
    if (this.wakeWordProvider) {
      await this.wakeWordProvider.initialize();
    }

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

    // Cancel all pending text bridge requests
    this.conversationService.cancelAll();

    // Destroy all voice connections
    voiceConnectionManager.destroyAll();

    // Dispose wake word provider
    if (this.wakeWordProvider) {
      await this.wakeWordProvider.dispose();
    }

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

    // Ready event - initialize text bridge after login
    this.client.once(Events.ClientReady, (client) => {
      logger.info(`Logged in as ${client.user.tag}`);

      this.textBridge
        .initialize()
        .then(() => {
          logger.info('Text bridge ready');
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to initialize text bridge: ${message}`);
          process.exit(1);
        });
    });

    // Slash command handling
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      handleCommand(interaction, commandContext).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Command error: ${message}`);
      });
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
      this.voiceAssistant.handleUserJoin(guildId, userId, newState.member ?? undefined);
    }

    // User left our channel
    if (oldState.channelId === ourChannelId && newState.channelId !== ourChannelId) {
      this.voiceAssistant.handleUserLeave(guildId, userId);
    }
  }
}
