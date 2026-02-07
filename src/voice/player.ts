import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'node:stream';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { getSoundPath, soundExists, splitTextForTTS, saveAudioBuffer } from '../utils/audio.js';
import type { TTSProvider } from '../providers/tts/index.js';

interface AudioQueueItem {
  file: string;
  index: number;
  deleteAfter: boolean;
}

/**
 * Manages audio playback for voice connections
 */
export class VoicePlayer {
  private player: AudioPlayer;
  private queue: AudioQueueItem[] = [];
  private currentIndex = 0;
  private isPlaying = false;
  private connection: VoiceConnection | null = null;
  private ttsProvider: TTSProvider | null = null;
  private onFinishCallback: (() => void) | null = null;

  constructor() {
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.setupPlayerHandlers();
  }

  /**
   * Set the TTS provider for synthesizing speech
   */
  setTTSProvider(provider: TTSProvider): void {
    this.ttsProvider = provider;
  }

  /**
   * Set the voice connection to play audio on
   */
  setConnection(connection: VoiceConnection): void {
    this.connection = connection;
    connection.subscribe(this.player);

    // Send a short silence frame to kick-start Discord audio receiving
    // Discord doesn't send user audio until the bot has subscribed and sent at least one packet
    const silenceBuffer = Buffer.alloc(48000 * 2 * 0.25, 0); // 250ms of silence (48kHz, 16-bit mono)
    const silenceStream = Readable.from(silenceBuffer);
    const silenceResource = createAudioResource(silenceStream, { inputType: StreamType.Raw });
    this.player.play(silenceResource);
    logger.debug('Sent initial silence frame to enable audio receiving');
  }

  /**
   * Set callback for when all audio finishes playing
   */
  onFinish(callback: () => void): void {
    this.onFinishCallback = callback;
  }

  /**
   * Play a sound effect
   */
  async playSound(soundName: string, volume = 1): Promise<void> {
    if (!config.bot.playSounds) {
      return;
    }

    const soundPath = getSoundPath(soundName);
    if (!(await soundExists(soundName))) {
      logger.warn(`Sound file not found: ${soundName}`);
      return;
    }

    return this.playFile(soundPath, volume, false);
  }

  /**
   * Play an audio file
   */
  async playFile(filePath: string, volume = 1, deleteAfter = false): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connection) {
        reject(new Error('No voice connection'));
        return;
      }

      try {
        let resource;

        if (volume !== 1) {
          // Use ffmpeg for volume adjustment
          const stream = ffmpeg(filePath)
            .audioFilters(`volume=${volume}`)
            .format('opus')
            .pipe() as Readable;

          resource = createAudioResource(stream);
        } else {
          resource = createAudioResource(createReadStream(filePath));
        }

        this.player.play(resource);

        const onIdle = async () => {
          this.player.off(AudioPlayerStatus.Idle, onIdle);
          if (deleteAfter) {
            try {
              await fs.unlink(filePath);
            } catch {
              // Ignore cleanup errors
            }
          }
          resolve();
        };

        this.player.once(AudioPlayerStatus.Idle, onIdle);
        this.player.once('error', (error) => {
          this.player.off(AudioPlayerStatus.Idle, onIdle);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Speak text using TTS
   */
  async speak(text: string): Promise<void> {
    if (!this.ttsProvider) {
      throw new Error('TTS provider not configured');
    }

    if (!this.connection) {
      throw new Error('No voice connection');
    }

    // Split text into chunks for better TTS handling
    const chunks = splitTextForTTS(text);
    this.currentIndex = 0;
    this.queue = [];

    logger.debug(`Speaking ${chunks.length} text chunks`);

    // Generate all TTS chunks
    for (let i = 0; i < chunks.length; i++) {
      try {
        const audioBuffer = await this.ttsProvider.synthesize(chunks[i]);
        const filename = `tts_${Date.now()}_${i}.mp3`;
        const filePath = await saveAudioBuffer(audioBuffer, filename);

        this.queue.push({
          file: filePath,
          index: i,
          deleteAfter: true,
        });
      } catch (error) {
        logger.error(`TTS synthesis failed for chunk ${i}: ${error}`);
      }
    }

    // Play the queue
    if (this.queue.length > 0) {
      this.isPlaying = true;
      await this.playQueue();
    }
  }

  /**
   * Stop all audio playback and clear queue
   */
  stop(): void {
    this.player.stop();
    this.clearQueue();
    this.isPlaying = false;
    logger.debug('Audio playback stopped');
  }

  /**
   * Check if currently playing audio
   */
  get playing(): boolean {
    return this.isPlaying;
  }

  private setupPlayerHandlers(): void {
    this.player.on('error', (error) => {
      logger.error(`Audio player error: ${error.message}`);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      // Audio finished, could trigger next in queue
    });
  }

  private async playQueue(): Promise<void> {
    // Sort queue by index
    this.queue.sort((a, b) => a.index - b.index);

    while (this.queue.length > 0 && this.isPlaying) {
      const item = this.queue.find((q) => q.index === this.currentIndex);

      if (item) {
        try {
          await this.playFile(item.file, 1, item.deleteAfter);
          this.queue = this.queue.filter((q) => q.index !== this.currentIndex);
          this.currentIndex++;
        } catch (error) {
          logger.error(`Failed to play queue item: ${error}`);
          this.currentIndex++;
        }
      } else {
        // Wait for missing chunk
        await this.sleep(100);
      }
    }

    this.isPlaying = false;
    this.currentIndex = 0;
    this.queue = [];

    if (this.onFinishCallback) {
      this.onFinishCallback();
    }
  }

  private clearQueue(): void {
    // Delete any pending TTS files
    for (const item of this.queue) {
      if (item.deleteAfter) {
        fs.unlink(item.file).catch(() => {});
      }
    }
    this.queue = [];
    this.currentIndex = 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const voicePlayer = new VoicePlayer();
