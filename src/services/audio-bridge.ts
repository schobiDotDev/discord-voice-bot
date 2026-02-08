import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

/**
 * Audio routing via BlackHole virtual audio devices.
 *
 * - Playback: TTS audio → BlackHole 2ch → Discord mic input
 * - Recording: Discord audio output → BlackHole 16ch → ffmpeg → WAV file
 *
 * Naming convention (from bot's perspective):
 * - blackholeInput = device that feeds INTO Discord (BlackHole 2ch)
 * - blackholeOutput = device that captures FROM Discord (BlackHole 16ch)
 */
export class AudioBridge {
  private playbackDevice: string;  // BlackHole 2ch — bot speaks into Discord
  private recordDevice: string;    // BlackHole 16ch — bot records from Discord
  private systemDevice: string;
  private recordingsDir: string;
  private deviceIndex: number | null = null;
  private playbackDeviceIndex: number | null = null;

  constructor() {
    this.playbackDevice = config.dmCall.blackholeInput;
    this.recordDevice = config.dmCall.blackholeOutput;
    this.systemDevice = config.dmCall.systemAudioDevice;
    this.recordingsDir = join(process.cwd(), 'recordings');
    mkdirSync(this.recordingsDir, { recursive: true });
  }

  /**
   * Prepare system audio routing for a DM call.
   * Sets system input to BlackHole 2ch and output to BlackHole 16ch.
   */
  prepareForCall(): void {
    this.switchAudioInput(this.playbackDevice);  // BlackHole 2ch as system input
    this.switchAudioOutput(this.recordDevice);   // BlackHole 16ch as system output
    logger.info('Audio prepared for DM call');
  }

  /**
   * Play a WAV/audio buffer into Discord via BlackHole.
   * Uses ffmpeg audiotoolbox to send audio directly to BlackHole 2ch
   * without changing the system output device. This avoids triggering
   * Discord's WebRTC echo cancellation.
   */
  async playToDiscord(audioBuffer: Buffer): Promise<void> {
    const tmpFile = join(this.recordingsDir, `tts-${Date.now()}.wav`);
    writeFileSync(tmpFile, audioBuffer);
    const deviceIdx = await this.getPlaybackDeviceIndex();

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-re', '-i', tmpFile,
          '-af', 'adelay=500|500,apad=pad_dur=0.5',
          '-f', 'audiotoolbox',
          '-audio_device_index', String(deviceIdx),
          '-',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg playback exit ${code}`));
        });
        proc.on('error', reject);
      });

      logger.debug('TTS playback complete');
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Start recording from BlackHole 16ch (Discord's audio output).
   * Returns a handle to stop the recording later.
   */
  async startRecording(): Promise<RecordingHandle> {
    const deviceIdx = await this.getRecordDeviceIndex();
    const outFile = join(this.recordingsDir, `response-${Date.now()}.wav`);

    logger.info(`Recording from avfoundation device :${deviceIdx}`);

    const proc = spawn('ffmpeg', [
      '-y',
      '-f', 'avfoundation',
      '-i', `:${deviceIdx}`,
      '-ar', '16000',
      '-ac', '1',
      '-t', String(config.dmCall.timeout),
      outFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    return { process: proc, filePath: outFile };
  }

  /**
   * Stop a recording and wait for ffmpeg to finish writing.
   */
  async stopRecording(handle: RecordingHandle): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.process.kill('SIGKILL');
        reject(new Error('Recording stop timeout'));
      }, 5000);

      handle.process.on('close', () => {
        clearTimeout(timer);
        logger.debug(`Recording saved: ${handle.filePath}`);
        resolve(handle.filePath);
      });

      // Send quit signal to ffmpeg (graceful stop)
      handle.process.kill('SIGTERM');
    });
  }

  /** Restore system audio output to default device */
  restoreAudio(): void {
    try {
      this.switchAudioOutput(this.systemDevice);
    } catch {
      // Non-critical — system audio may already be on the right device
    }
  }

  /** Clean up a recording file */
  cleanup(filePath: string): void {
    try { unlinkSync(filePath); } catch {}
  }

  private switchAudioOutput(device: string): void {
    execSync(`SwitchAudioSource -s "${device}" -t output`, { stdio: 'pipe' });
    logger.debug(`Audio output → ${device}`);
  }

  private switchAudioInput(device: string): void {
    execSync(`SwitchAudioSource -s "${device}" -t input`, { stdio: 'pipe' });
    logger.debug(`Audio input → ${device}`);
  }

  /**
   * Find the audiotoolbox output device index for BlackHole 2ch.
   * This allows ffmpeg to play directly to the device without
   * changing the system default output.
   */
  private async getPlaybackDeviceIndex(): Promise<number> {
    if (this.playbackDeviceIndex !== null) return this.playbackDeviceIndex;

    let output: string;
    try {
      output = execSync(
        'ffmpeg -f lavfi -i "sine=frequency=1:duration=0.001" -f audiotoolbox -list_devices true - 2>&1',
        { encoding: 'utf-8' },
      );
    } catch (err: unknown) {
      output = (err as { stdout?: string; stderr?: string }).stdout
        ?? (err as { stderr?: string }).stderr
        ?? '';
    }

    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/\[(\d+)\]\s+(.+?)(?:,\s|$)/);
      if (match && match[2].trim().includes(this.playbackDevice)) {
        this.playbackDeviceIndex = parseInt(match[1], 10);
        logger.debug(`Playback device "${this.playbackDevice}" → audiotoolbox index ${this.playbackDeviceIndex}`);
        return this.playbackDeviceIndex;
      }
    }

    throw new Error(`Playback device not found: ${this.playbackDevice}`);
  }

  /**
   * Find the avfoundation device index for the recording device.
   * Cached after first lookup.
   */
  private async getRecordDeviceIndex(): Promise<number> {
    if (this.deviceIndex !== null) return this.deviceIndex;

    // ffmpeg -list_devices prints to stderr, exits with error
    let output: string;
    try {
      execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', { encoding: 'utf-8' });
      output = '';
    } catch (err: unknown) {
      // ffmpeg always exits non-zero for -list_devices, output is in the error
      output = (err as { stdout?: string; stderr?: string }).stdout
        ?? (err as { stderr?: string }).stderr
        ?? '';
    }

    const lines = output.split('\n');
    let inAudio = false;

    for (const line of lines) {
      if (line.includes('AVFoundation audio devices')) {
        inAudio = true;
        continue;
      }
      if (!inAudio) continue;

      const match = line.match(/\[(\d+)\]\s+(.+)/);
      if (match && match[2].includes(this.recordDevice)) {
        this.deviceIndex = parseInt(match[1], 10);
        logger.debug(`Record device "${this.recordDevice}" → index ${this.deviceIndex}`);
        return this.deviceIndex;
      }
    }

    throw new Error(`Audio input device not found: ${this.recordDevice}`);
  }
}

export interface RecordingHandle {
  process: ChildProcess;
  filePath: string;
}
