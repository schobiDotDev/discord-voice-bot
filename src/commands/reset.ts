import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { ConversationService } from '../services/index.js';

export const data = new SlashCommandBuilder()
  .setName('reset')
  .setDescription('Reset your conversation history');

export async function execute(
  interaction: ChatInputCommandInteraction,
  conversationService: ConversationService
): Promise<void> {
  const userId = interaction.user.id;

  conversationService.reset(userId);

  await interaction.reply({
    content: '✅ Conversation history has been reset.',
    ephemeral: true,
  });

  logger.info(`Conversation reset`, {
    userId,
    guildId: interaction.guildId!,
  });
}
