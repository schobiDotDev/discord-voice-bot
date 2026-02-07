import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync, statSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface RecorderConfig {
  inputDeviceIndex: number;
  sampleRate: number;
  channels: number;
  chunkSeconds: number;
  volumeThresholdDb: number;
}

export interface RecorderEvents {
  chunk: (filePath: string, volumeDb: number) => void;
  error: (error: Error) => void;
}

/**
 * Records audio from a virtual audio device using ffmpeg
 * Emits chunks with volume detection for VAD
 */
export class Recorder extends EventEmitter {
  private config: RecorderConfig;
  private process: ChildProcess | null = null;
  private chunkCounter = 0;
  private tmpDir: string;

  constructor(config: RecorderConfig, tmpDir: string) {
    super();
    this.config = config;
    this.tmpDir = tmpDir;
  }

  /**
   * Record a single chunk of audio
   * Returns the file path and detected volume level
   */
  async recordChunk(): Promise<{ filePath: string; volumeDb: number }> {
    const chunkFile = `${this.tmpDir}/chunk-${Date.now()}-${this.chunkCounter++}.wav`;

    return new Promise((resolve, reject) => {
      // ffmpeg command to record from AVFoundation device
      // -f avfoundation: macOS audio capture
      // -i :N: audio device index (no video)
      // -t N: duration in seconds
      // -ar: sample rate
      // -ac: channels
      const args = [
        '-y', // Overwrite output
        '-f', 'avfoundation',
        '-i', `:${this.config.inputDeviceIndex}`,
        '-t', String(this.config.chunkSeconds),
        '-ar', String(this.config.sampleRate),
        '-ac', String(this.config.channels),
        '-af', 'volumedetect', // Add volume detection filter
        chunkFile,
      ];

      logger.debug(`Recording chunk: ffmpeg ${args.join(' ')}`);

      this.process = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      this.process.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      this.process.on('close', (code) => {
        this.process = null;

        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
          return;
        }

        // Parse volume from ffmpeg output
        const volumeDb = this.parseVolume(stderr);

        // Verify file exists and has content
        if (!existsSync(chunkFile)) {
          reject(new Error('Chunk file was not created'));
          return;
        }

        const stats = statSync(chunkFile);
        if (stats.size < 1000) {
          // Less than 1KB is probably just headers
          unlinkSync(chunkFile);
          reject(new Error('Chunk file is too small (no audio data)'));
          return;
        }

        resolve({ filePath: chunkFile, volumeDb });
      });

      this.process.on('error', (err) => {
        this.process = null;
        reject(err);
      });
    });
  }

  /**
   * Check if a chunk contains speech (based on volume threshold)
   */
  isSpeech(volumeDb: number): boolean {
    return volumeDb > this.config.volumeThresholdDb;
  }

  /**
   * Stop any ongoing recording
   */
  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /**
   * Get volume level of an audio file (returns dB, higher = louder)
   */
  async getVolume(filePath: string): Promise<number> {
    try {
      const { stderr } = await execAsync(
        `ffmpeg -i "${filePath}" -af volumedetect -f null - 2>&1`
      );
      return this.parseVolume(stderr);
    } catch {
      return -Infinity;
    }
  }

  /**
   * Concatenate multiple audio files into one
   */
  async concatenateChunks(chunkPaths: string[], outputPath: string): Promise<void> {
    if (chunkPaths.length === 0) {
      throw new Error('No chunks to concatenate');
    }

    if (chunkPaths.length === 1) {
      // Just copy the single file
      const { execSync } = await import('node:child_process');
      execSync(`cp "${chunkPaths[0]}" "${outputPath}"`);
      return;
    }

    // Create a concat list file
    const listFile = `${this.tmpDir}/concat-${Date.now()}.txt`;
    const listContent = chunkPaths.map((p) => `file '${p}'`).join('\n');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(listFile, listContent);

    try {
      await execAsync(
        `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`
      );
    } finally {
      try {
        unlinkSync(listFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Parse volume from ffmpeg volumedetect output
   */
  private parseVolume(ffmpegOutput: string): number {
    // Look for: mean_volume: -23.5 dB
    const match = ffmpegOutput.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    if (match) {
      return parseFloat(match[1]);
    }

    // Look for: max_volume: -12.3 dB
    const maxMatch = ffmpegOutput.match(/max_volume:\s*([-\d.]+)\s*dB/);
    if (maxMatch) {
      return parseFloat(maxMatch[1]);
    }

    return -Infinity; // No audio detected
  }

  /**
   * Clean up chunk files
   */
  cleanupChunk(filePath: string): void {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
