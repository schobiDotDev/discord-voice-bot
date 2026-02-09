import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import logger from '../utils/logger.js';
import type { ConversationService } from '../services/index.js';

export const data = new SlashCommandBuilder()
  .setName('reset')
  .setDescription('Cancel any pending voice request');

export async function execute(
  interaction: ChatInputCommandInteraction,
  conversationService: ConversationService
): Promise<void> {
  const userId = interaction.user.id;

  if (conversationService.hasPendingRequest(userId)) {
    conversationService.cancel(userId);
    await interaction.reply({
      content: '✅ Pending request has been cancelled.',
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: 'ℹ️ No pending request to cancel.',
      ephemeral: true,
    });
  }

  logger.info(`Reset command used`, {
    userId,
    guildId: interaction.guildId!,
  });
}
