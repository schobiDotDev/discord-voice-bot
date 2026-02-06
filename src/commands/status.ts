import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { voiceConnectionManager } from '../voice/index.js';
import type { VoiceAssistant } from '../services/index.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show bot status and configuration');

export async function execute(
  interaction: ChatInputCommandInteraction,
  voiceAssistant: VoiceAssistant
): Promise<void> {
  const guildId = interaction.guildId!;
  const isConnected = voiceConnectionManager.isConnected(guildId);
  const mode = voiceAssistant.getMode(guildId);
  const isProcessing = voiceAssistant.isProcessing(guildId);

  // Format access control info
  let accessInfo = 'Everyone';
  if (config.access.ownerOnly) {
    accessInfo = '🔒 Owner Only';
  } else if (config.access.allowedUsers.length > 0) {
    accessInfo = `Allowlist (${config.access.allowedUsers.length} users)`;
  } else if (config.access.blockedUsers.length > 0) {
    accessInfo = `Blocklist (${config.access.blockedUsers.length} users)`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🤖 Voice Bot Status')
    .setColor(isConnected ? 0x00ff00 : 0xff0000)
    .addFields(
      {
        name: '🔊 Voice Connection',
        value: isConnected ? `✅ Connected (${mode} mode)` : '❌ Not connected',
        inline: true,
      },
      {
        name: '⚡ Processing',
        value: isProcessing ? '🔄 Processing...' : '💤 Idle',
        inline: true,
      },
      {
        name: '👥 Access',
        value: accessInfo,
        inline: true,
      },
      {
        name: '🎤 STT Provider',
        value: config.stt.provider,
        inline: true,
      },
      {
        name: '🔈 TTS Provider',
        value: config.tts.provider,
        inline: true,
      },
      {
        name: '📝 Text Bridge',
        value: `<#${config.textBridge.channelId}>`,
        inline: true,
      },
      {
        name: '🗣️ Trigger Words',
        value: config.bot.triggers.join(', ') || 'None',
        inline: false,
      }
    )
    .setTimestamp()
    .setFooter({ text: 'Discord Voice Bot' });

  await interaction.reply({
    embeds: [embed],
    ephemeral: true,
  });
}
