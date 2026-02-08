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

  constructor() {
    this.playbackDevice = config.dmCall.blackholeInput;
    this.recordDevice = config.dmCall.blackholeOutput;
    this.systemDevice = config.dmCall.systemAudioDevice;
    this.recordingsDir = join(process.cwd(), 'recordings');
    mkdirSync(this.recordingsDir, { recursive: true });
  }

  /**
   * Play a WAV/audio buffer into Discord via BlackHole.
   * Switches system output → BlackHole 2ch → plays with afplay → restores.
   */
  async playToDiscord(audioBuffer: Buffer): Promise<void> {
    const tmpFile = join(this.recordingsDir, `tts-${Date.now()}.wav`);
    writeFileSync(tmpFile, audioBuffer);

    try {
      this.switchAudioOutput(this.playbackDevice);

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('afplay', [tmpFile]);
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`afplay exit ${code}`)));
        proc.on('error', reject);
      });

      logger.debug('TTS playback complete');
    } finally {
      this.restoreAudio();
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
