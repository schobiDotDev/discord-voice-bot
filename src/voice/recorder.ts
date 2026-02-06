import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import prism from 'prism-media';
import { logger } from '../utils/logger.js';
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
 * Manages audio recording from voice connections
 */
export class VoiceRecorder {
  private activeRecordings: Map<string, AbortController> = new Map();
  private callback: RecordingCallback | null = null;

  /**
   * Set the callback for when recording is complete
   */
  onRecordingComplete(callback: RecordingCallback): void {
    this.callback = callback;
  }

  /**
   * Start recording for all users in a voice channel
   */
  startRecordingAll(connection: VoiceConnection, userIds: string[]): void {
    for (const userId of userIds) {
      this.startRecording(connection, userId);
    }
  }

  /**
   * Start recording audio from a specific user
   */
  startRecording(connection: VoiceConnection, userId: string): void {
    // Stop any existing recording for this user
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

    // Decode Opus to PCM
    const opusDecoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 1,
      rate: 48000,
    });

    const writeStream = createWriteStream(pcmPath);
    let startTime = Date.now();
    let bytesWritten = 0;

    // Track bytes for duration calculation
    const byteCounter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.length;
        callback(null, chunk);
      },
    });

    // Handle stream completion
    const handleComplete = async () => {
      const duration = Date.now() - startTime;
      const mp3Path = getMp3Path(userId);

      logger.debug(`Recording complete for user ${userId}`, {
        duration,
        bytesWritten,
      });

      // Check minimum speech duration
      if (duration < config.vad.minSpeechDuration) {
        logger.debug(`Recording too short, ignoring`, { userId, duration });
        await cleanupAudioFiles(userId);
        this.restartRecording(connection, userId);
        return;
      }

      try {
        // Convert PCM to MP3
        await convertPcmToMp3(pcmPath, mp3Path);

        // Notify callback
        if (this.callback) {
          this.callback({
            userId,
            pcmPath,
            mp3Path,
            duration,
          });
        }
      } catch (error) {
        logger.error(`Failed to process recording: ${error}`, { userId });
        await cleanupAudioFiles(userId);
        this.restartRecording(connection, userId);
      }
    };

    // Pipe the stream
    opusStream
      .pipe(opusDecoder)
      .pipe(byteCounter)
      .pipe(writeStream)
      .on('finish', () => {
        this.activeRecordings.delete(userId);
        void handleComplete();
      })
      .on('error', (error) => {
        logger.error(`Recording stream error: ${error.message}`, { userId });
        this.activeRecordings.delete(userId);
        void cleanupAudioFiles(userId);
      });

    // Handle abort
    abortController.signal.addEventListener('abort', () => {
      opusStream.destroy();
      opusDecoder.destroy();
      writeStream.destroy();
    });
  }

  /**
   * Restart recording for a user (after processing)
   */
  restartRecording(connection: VoiceConnection, userId: string): void {
    // Small delay before restarting to avoid overlapping streams
    setTimeout(() => {
      if (connection.state.status !== 'destroyed') {
        this.startRecording(connection, userId);
      }
    }, 100);
  }

  /**
   * Stop recording for a specific user
   */
  stopRecording(userId: string): void {
    const controller = this.activeRecordings.get(userId);
    if (controller) {
      controller.abort();
      this.activeRecordings.delete(userId);
      logger.debug(`Stopped recording for user ${userId}`);
    }
  }

  /**
   * Stop all active recordings
   */
  stopAll(): void {
    for (const [userId, controller] of this.activeRecordings) {
      controller.abort();
      logger.debug(`Stopped recording for user ${userId}`);
    }
    this.activeRecordings.clear();
  }

  /**
   * Check if user is being recorded
   */
  isRecording(userId: string): boolean {
    return this.activeRecordings.has(userId);
  }
}

export const voiceRecorder = new VoiceRecorder();
