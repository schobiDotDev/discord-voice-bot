import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel, Guild } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * Manages voice channel connections for the bot
 */
export class VoiceConnectionManager {
  private connections: Map<string, VoiceConnection> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_DELAY_MS = 5000;

  /**
   * Join a voice channel
   */
  async join(channel: VoiceBasedChannel): Promise<VoiceConnection> {
    const guildId = channel.guild.id;

    // Check for existing connection
    const existing = this.connections.get(guildId);
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      logger.debug(`Already connected to voice in guild ${guildId}`);
      return existing;
    }

    logger.info(`Joining voice channel: ${channel.name}`, {
      guildId,
      channelId: channel.id,
    });

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.setupConnectionHandlers(connection, channel.guild);
    this.connections.set(guildId, connection);
    this.reconnectAttempts.set(guildId, 0);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      logger.info(`Voice connection ready`, { guildId });
      return connection;
    } catch (error) {
      connection.destroy();
      this.connections.delete(guildId);
      throw new Error(`Failed to join voice channel: ${error}`);
    }
  }

  /**
   * Leave a voice channel
   */
  leave(guildId: string): boolean {
    const connection = this.connections.get(guildId);
    if (!connection) {
      return false;
    }

    logger.info(`Leaving voice channel`, { guildId });
    connection.destroy();
    this.connections.delete(guildId);
    this.reconnectAttempts.delete(guildId);
    return true;
  }

  /**
   * Get existing connection for a guild
   */
  get(guildId: string): VoiceConnection | undefined {
    return this.connections.get(guildId);
  }

  /**
   * Check if bot is connected to a guild
   */
  isConnected(guildId: string): boolean {
    const connection = this.connections.get(guildId);
    return (
      connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed
    );
  }

  /**
   * Destroy all connections (cleanup)
   */
  destroyAll(): void {
    logger.info(`Destroying all voice connections`);
    for (const [guildId, connection] of this.connections) {
      connection.destroy();
      logger.debug(`Destroyed connection for guild ${guildId}`);
    }
    this.connections.clear();
    this.reconnectAttempts.clear();
  }

  private setupConnectionHandlers(connection: VoiceConnection, guild: Guild): void {
    const guildId = guild.id;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      logger.warn(`Voice disconnected`, { guildId });

      const attempts = this.reconnectAttempts.get(guildId) ?? 0;

      if (attempts < VoiceConnectionManager.MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts.set(guildId, attempts + 1);

        try {
          // Try to reconnect
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          logger.info(`Reconnecting to voice`, { guildId, attempt: attempts + 1 });
        } catch {
          // Try manual reconnect after delay
          await this.sleep(VoiceConnectionManager.RECONNECT_DELAY_MS);
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.rejoin();
          }
        }
      } else {
        // Give up after max attempts
        logger.error(`Failed to reconnect after ${attempts} attempts`, { guildId });
        connection.destroy();
        this.connections.delete(guildId);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      logger.info(`Voice connection destroyed`, { guildId });
      this.connections.delete(guildId);
      this.reconnectAttempts.delete(guildId);
    });

    connection.on('error', (error) => {
      logger.error(`Voice connection error: ${error.message}`, { guildId });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const voiceConnectionManager = new VoiceConnectionManager();
