import { spawn, type ChildProcess, exec } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { logger } from './logger.js';
import type { TTSProvider } from '../../providers/tts/interface.js';

const execAsync = promisify(exec);

export interface SpeakerConfig {
  outputDevice: string; // Device to play TTS to (Discord mic input)
  systemDevice: string; // System output to restore after TTS
  ttsProvider: TTSProvider;
}

/**
 * Handles TTS playback to a virtual audio device
 * Uses afplay and SwitchAudioSource on macOS
 */
export class Speaker {
  private config: SpeakerConfig;
  private playbackProcess: ChildProcess | null = null;
  private tmpDir: string;
  private fileCounter = 0;

  constructor(config: SpeakerConfig, tmpDir: string) {
    this.config = config;
    this.tmpDir = tmpDir;
  }

  /**
   * Synthesize text and play to the virtual audio device
   */
  async speak(text: string): Promise<void> {
    if (!text.trim()) {
      logger.debug('Empty text, skipping speech');
      return;
    }

    logger.info(`Speaking: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);

    try {
      // Generate audio via TTS provider
      const audioBuffer = await this.config.ttsProvider.synthesize(text);

      // Write to temp file
      const tmpFile = `${this.tmpDir}/tts-${Date.now()}-${this.fileCounter++}.wav`;
      writeFileSync(tmpFile, audioBuffer);

      // Play to BlackHole device
      await this.playToDevice(tmpFile);

      // Clean up temp file
      this.cleanupFile(tmpFile);

      logger.debug('Speech playback complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Speech playback failed: ${message}`);
      throw error;
    }
  }

  /**
   * Play audio from a file path
   */
  async playFile(filePath: string): Promise<void> {
    await this.playToDevice(filePath);
  }

  /**
   * Stop any ongoing playback
   */
  stop(): void {
    if (this.playbackProcess) {
      this.playbackProcess.kill('SIGTERM');
      this.playbackProcess = null;
    }
  }

  /**
   * Check if currently playing
   */
  isPlaying(): boolean {
    return this.playbackProcess !== null;
  }

  /**
   * Play an audio file to the virtual device
   * Switches system output, plays, then restores
   */
  private async playToDevice(filePath: string): Promise<void> {
    // Stop any existing playback
    this.stop();

    // Switch to the virtual device
    await this.switchAudioOutput(this.config.outputDevice);

    try {
      await this.playWithAfplay(filePath);
    } finally {
      // Always restore system output
      await this.switchAudioOutput(this.config.systemDevice);
    }
  }

  /**
   * Switch the system audio output device
   */
  private async switchAudioOutput(deviceName: string): Promise<void> {
    try {
      await execAsync(`SwitchAudioSource -s "${deviceName}" -t output`);
      logger.debug(`Switched audio output to: ${deviceName}`);
    } catch (error) {
      // SwitchAudioSource might not be installed, log but don't fail
      logger.warn(`Failed to switch audio output: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Play audio file using afplay (macOS native)
   */
  private async playWithAfplay(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.playbackProcess = spawn('afplay', [filePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      this.playbackProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      this.playbackProcess.on('close', (code) => {
        this.playbackProcess = null;

        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`afplay exited with code ${code}: ${stderr}`));
        }
      });

      this.playbackProcess.on('error', (err) => {
        this.playbackProcess = null;
        reject(err);
      });
    });
  }

  /**
   * Clean up a temp file
   */
  private cleanupFile(filePath: string): void {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
