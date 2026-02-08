import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import { createWriteStream } from 'node:fs';
// Use opusscript (pure JS) instead of @discordjs/opus (native C++) to avoid segfaults
import OpusScript from 'opusscript';
import logger from '../utils/logger.js';
import { config } from '../config.js';
import { getPcmPath, getMp3Path, convertPcmToMp3, cleanupAudioFiles } from '../utils/audio.js';

export interface RecordingResult {
  userId: string;
  pcmPath: string;
  mp3Path: string;
  duration: number;
}

export type RecordingCallback = (result: RecordingResult) => void;

/**
 * Manages audio recording from voice connections.
 * Uses @discordjs/opus directly instead of prism-media for stability.
 */
export class VoiceRecorder {
  private activeRecordings: Map<string, AbortController> = new Map();
  private callback: RecordingCallback | null = null;
  private decoder: OpusScript;

  constructor() {
    // 48kHz mono, standard for Discord voice
    this.decoder = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  }

  onRecordingComplete(callback: RecordingCallback): void {
    this.callback = callback;
  }

  startRecordingAll(connection: VoiceConnection, userIds: string[]): void {
    for (const userId of userIds) {
      this.startRecording(connection, userId);
    }
  }

  startRecording(connection: VoiceConnection, userId: string): void {
    this.stopRecording(userId);

    const abortController = new AbortController();
    this.activeRecordings.set(userId, abortController);

    const pcmPath = getPcmPath(userId);
    const receiver = connection.receiver;

    logger.debug(`Starting recording for user ${userId}`);

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: config.vad.silenceDuration,
      },
    });

    const writeStream = createWriteStream(pcmPath);
    const startTime = Date.now();
    let bytesWritten = 0;
    let packetCount = 0;
    let aborted = false;

    // Manually decode each opus packet and write PCM
    opusStream.on('data', (opusPacket: Buffer) => {
      if (aborted) return;
      try {
        packetCount++;
        const pcm = this.decoder.decode(opusPacket);
        bytesWritten += pcm.length;
        writeStream.write(pcm);

        if (packetCount === 1) {
          logger.debug(`First opus packet decoded for user ${userId}`, {
            opusBytes: opusPacket.length,
            pcmBytes: pcm.length,
          });
        } else if (packetCount % 100 === 0) {
          logger.debug(`Received ${packetCount} packets from user ${userId}`);
        }
      } catch (err) {
        logger.error(`Opus decode error: ${err}`, { userId, packetCount });
      }
    });

    opusStream.on('end', () => {
      if (aborted) return;
      writeStream.end();
      this.activeRecordings.delete(userId);

      const duration = Date.now() - startTime;
      logger.debug(`Recording complete for user ${userId}`, { duration, bytesWritten, packetCount });

      void this.handleComplete(userId, pcmPath, duration, bytesWritten, connection);
    });

    opusStream.on('error', (error) => {
      logger.error(`Opus stream error: ${error.message}`, { userId });
      writeStream.end();
    });

    writeStream.on('error', (error) => {
      logger.error(`Write stream error: ${error.message}`, { userId });
    });

    // Handle abort
    abortController.signal.addEventListener('abort', () => {
      aborted = true;
      opusStream.destroy();
      writeStream.end();
    });
  }

  private async handleComplete(
    userId: string,
    pcmPath: string,
    duration: number,
    bytesWritten: number,
    connection: VoiceConnection,
  ): Promise<void> {
    if (duration < config.vad.minSpeechDuration || bytesWritten === 0) {
      logger.debug(`Recording too short, ignoring`, { userId, duration, bytesWritten });
      await cleanupAudioFiles(userId);
      this.restartRecording(connection, userId);
      return;
    }

    try {
      const mp3Path = getMp3Path(userId);
      await convertPcmToMp3(pcmPath, mp3Path);

      if (this.callback) {
        this.callback({ userId, pcmPath, mp3Path, duration });
      }
    } catch (error) {
      logger.error(`Failed to process recording: ${error}`, { userId });
      await cleanupAudioFiles(userId);
      this.restartRecording(connection, userId);
    }
  }

  restartRecording(connection: VoiceConnection, userId: string): void {
    setTimeout(() => {
      if (connection.state.status !== 'destroyed') {
        this.startRecording(connection, userId);
      }
    }, 100);
  }

  stopRecording(userId: string): void {
    const controller = this.activeRecordings.get(userId);
    if (controller) {
      controller.abort();
      this.activeRecordings.delete(userId);
      logger.debug(`Stopped recording for user ${userId}`);
    }
  }

  stopAll(): void {
    for (const [userId, controller] of this.activeRecordings) {
      controller.abort();
      logger.debug(`Stopped recording for user ${userId}`);
    }
    this.activeRecordings.clear();
  }

  isRecording(userId: string): boolean {
    return this.activeRecordings.has(userId);
  }
}

export const voiceRecorder = new VoiceRecorder();
