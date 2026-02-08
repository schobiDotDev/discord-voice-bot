import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import logger from '../utils/logger.js';
import { voiceConnectionManager } from '../voice/index.js';
import type { VoiceAssistantMulti, VoiceMode } from '../services/index.js';

export const data = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Join your voice channel and start listening')
  .addStringOption((option) =>
    option
      .setName('mode')
      .setDescription('Voice assistant mode')
      .setRequired(false)
      .addChoices(
        { name: 'Normal - Uses trigger words and plays sounds', value: 'normal' },
        { name: 'Silent - No confirmation sounds', value: 'silent' },
        { name: 'Free - No trigger word required', value: 'free' }
      )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  voiceAssistant: VoiceAssistantMulti
): Promise<void> {
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: '❌ You need to be in a voice channel first!',
      ephemeral: true,
    });
    return;
  }

  // Check for existing connection
  if (voiceConnectionManager.isConnected(interaction.guildId!)) {
    await interaction.reply({
      content: '❌ Already connected to a voice channel. Use `/leave` first.',
      ephemeral: true,
    });
    return;
  }

  const mode = (interaction.options.getString('mode') ?? 'normal') as VoiceMode;

  try {
    await interaction.deferReply({ ephemeral: true });

    const connection = await voiceConnectionManager.join(voiceChannel);
    await voiceAssistant.start(connection, voiceChannel, mode);

    let modeDescription = '';
    switch (mode) {
      case 'normal':
        modeDescription = 'Listening for trigger words.';
        break;
      case 'silent':
        modeDescription = 'Listening silently (no sounds).';
        break;
      case 'free':
        modeDescription = 'Listening to all speech (no trigger required).';
        break;
    }

    await interaction.editReply({
      content: `✅ Joined **${voiceChannel.name}**\n${modeDescription}`,
    });

    logger.info(`Joined voice channel`, {
      guildId: interaction.guildId!,
      channelId: voiceChannel.id,
      mode,
      userId: interaction.user.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to join voice channel: ${message}`, {
      guildId: interaction.guildId!,
    });

    await interaction.editReply({
      content: `❌ Failed to join voice channel: ${message}`,
    });
  }
}
