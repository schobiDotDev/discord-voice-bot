import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { logger } from '../utils/logger.js';
import { voiceConnectionManager } from '../voice/index.js';
import type { VoiceAssistant } from '../services/index.js';

export const data = new SlashCommandBuilder()
  .setName('leave')
  .setDescription('Leave the current voice channel');

export async function execute(
  interaction: ChatInputCommandInteraction,
  voiceAssistant: VoiceAssistant
): Promise<void> {
  const guildId = interaction.guildId!;

  if (!voiceConnectionManager.isConnected(guildId)) {
    await interaction.reply({
      content: '❌ Not connected to any voice channel.',
      ephemeral: true,
    });
    return;
  }

  try {
    voiceAssistant.stop(guildId);
    voiceConnectionManager.leave(guildId);

    await interaction.reply({
      content: '✅ Left the voice channel.',
      ephemeral: true,
    });

    logger.info(`Left voice channel`, {
      guildId,
      userId: interaction.user.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to leave voice channel: ${message}`, { guildId });

    await interaction.reply({
      content: `❌ Failed to leave: ${message}`,
      ephemeral: true,
    });
  }
}
