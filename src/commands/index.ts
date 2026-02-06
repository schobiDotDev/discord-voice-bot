import { Collection, REST, Routes, ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { VoiceAssistant, ConversationService } from '../services/index.js';

import * as joinCommand from './join.js';
import * as leaveCommand from './leave.js';
import * as resetCommand from './reset.js';
import * as statusCommand from './status.js';

// Command definitions
const commands = [
  joinCommand.data.toJSON(),
  leaveCommand.data.toJSON(),
  resetCommand.data.toJSON(),
  statusCommand.data.toJSON(),
];

export interface CommandContext {
  voiceAssistant: VoiceAssistant;
  conversationService: ConversationService;
}

/**
 * Register slash commands with Discord
 */
export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    logger.info('Registering slash commands...');

    if (config.discord.guildId) {
      // Register for specific guild (faster for development)
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body: commands }
      );
      logger.info(`Registered ${commands.length} commands for guild ${config.discord.guildId}`);
    } else {
      // Register globally
      await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands });
      logger.info(`Registered ${commands.length} global commands`);
    }
  } catch (error) {
    logger.error(`Failed to register commands: ${error}`);
    throw error;
  }
}

/**
 * Handle slash command interactions
 */
export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'join':
        await joinCommand.execute(interaction, context.voiceAssistant);
        break;
      case 'leave':
        await leaveCommand.execute(interaction, context.voiceAssistant);
        break;
      case 'reset':
        await resetCommand.execute(interaction, context.conversationService);
        break;
      case 'status':
        await statusCommand.execute(interaction, context.voiceAssistant);
        break;
      default:
        await interaction.reply({
          content: '❌ Unknown command.',
          ephemeral: true,
        });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Command execution error: ${message}`, {
      command: commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
    });

    const reply = {
      content: `❌ An error occurred: ${message}`,
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}
