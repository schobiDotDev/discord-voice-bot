import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface AudioDeviceInfo {
  index: number;
  name: string;
  type: 'input' | 'output';
}

export interface AudioDevicesConfig {
  inputDevice: string; // Device to record from (Discord speaker output)
  outputDevice: string; // Device to play TTS to (Discord mic input)
  systemDevice: string; // System output to restore after TTS playback
}

/**
 * Manages virtual audio devices (BlackHole on macOS)
 * Checks device availability and provides device indices for ffmpeg
 */
export class AudioDeviceManager {
  private config: AudioDevicesConfig;
  private inputDeviceIndex: number | null = null;

  constructor(config: AudioDevicesConfig) {
    this.config = config;
  }

  /**
   * Check that required audio devices exist and get their indices
   */
  async initialize(): Promise<boolean> {
    logger.info('Checking audio devices...');

    const devices = await this.listAVFoundationDevices();

    // Find input device (for recording)
    const inputDevice = devices.find(
      (d) => d.type === 'input' && d.name.includes(this.config.inputDevice)
    );
    if (!inputDevice) {
      logger.error(`Input device not found: ${this.config.inputDevice}`);
      logger.info('Available input devices:');
      devices.filter((d) => d.type === 'input').forEach((d) => logger.info(`  [${d.index}] ${d.name}`));
      return false;
    }
    this.inputDeviceIndex = inputDevice.index;
    logger.info(`Input device: [${inputDevice.index}] ${inputDevice.name}`);

    // Find output device (for TTS playback) - just verify it exists
    const outputDevice = devices.find(
      (d) => d.type === 'output' && d.name.includes(this.config.outputDevice)
    );
    if (!outputDevice) {
      logger.error(`Output device not found: ${this.config.outputDevice}`);
      logger.info('Available output devices:');
      devices.filter((d) => d.type === 'output').forEach((d) => logger.info(`  [${d.index}] ${d.name}`));
      return false;
    }
    logger.info(`Output device: ${outputDevice.name}`);

    // Check system device exists (for restoring after TTS)
    const systemDevice = devices.find(
      (d) => d.type === 'output' && d.name.includes(this.config.systemDevice)
    );
    if (!systemDevice) {
      logger.warn(`System output device not found: ${this.config.systemDevice}`);
    } else {
      logger.info(`System device: ${systemDevice.name}`);
    }

    // Check if SwitchAudioSource is available (needed for routing)
    const hasSwitchAudioSource = await this.checkSwitchAudioSource();
    if (!hasSwitchAudioSource) {
      logger.warn('SwitchAudioSource not found. Install via: brew install switchaudio-osx');
      logger.warn('TTS playback routing may not work correctly.');
    }

    return true;
  }

  /**
   * Get the ffmpeg input device string for recording
   */
  getInputDeviceString(): string {
    if (this.inputDeviceIndex === null) {
      throw new Error('Audio devices not initialized');
    }
    return `:${this.inputDeviceIndex}`;
  }

  /**
   * Get the input device index for recording
   */
  getInputDeviceIndex(): number {
    if (this.inputDeviceIndex === null) {
      throw new Error('Audio devices not initialized');
    }
    return this.inputDeviceIndex;
  }

  /**
   * Get the output device name for TTS playback
   */
  getOutputDevice(): string {
    return this.config.outputDevice;
  }

  /**
   * Get the system device name for restoring after TTS
   */
  getSystemDevice(): string {
    return this.config.systemDevice;
  }

  /**
   * List all AVFoundation audio devices
   */
  private async listAVFoundationDevices(): Promise<AudioDeviceInfo[]> {
    const devices: AudioDeviceInfo[] = [];

    try {
      // ffmpeg -f avfoundation -list_devices true -i "" outputs to stderr
      const { stderr } = await execAsync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true');

      const lines = stderr.split('\n');
      let currentType: 'video' | 'audio' | null = null;

      for (const line of lines) {
        // Detect section headers
        if (line.includes('AVFoundation video devices')) {
          currentType = 'video';
          continue;
        }
        if (line.includes('AVFoundation audio devices')) {
          currentType = 'audio';
          continue;
        }

        if (currentType !== 'audio') continue;

        // Parse device lines like "[0] BlackHole 16ch" or "[1] MacBook Air Microphone"
        const match = line.match(/\[(\d+)\]\s+(.+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const name = match[2].trim();

          // Determine if it's an input or output device based on name patterns
          // This is a heuristic — BlackHole can be both input and output
          const isOutput = name.includes('Speaker') || name.includes('Lautsprecher') || name.includes('Output');
          const isInput = !isOutput;

          // For BlackHole devices, add both input and output entries
          if (name.includes('BlackHole')) {
            devices.push({ index, name, type: 'input' });
            devices.push({ index, name, type: 'output' });
          } else {
            devices.push({ index, name, type: isInput ? 'input' : 'output' });
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to list audio devices: ${error instanceof Error ? error.message : String(error)}`);
    }

    return devices;
  }

  /**
   * Check if SwitchAudioSource is available
   */
  private async checkSwitchAudioSource(): Promise<boolean> {
    try {
      await execAsync('which SwitchAudioSource');
      return true;
    } catch {
      return false;
    }
  }
}
