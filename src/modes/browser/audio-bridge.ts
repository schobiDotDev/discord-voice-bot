import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page, CDPSession } from 'puppeteer';
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import type { TTSProvider } from '../../providers/tts/interface.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const CAPTURE_INTERVAL_MS = 200;

export interface AudioBridgeConfig {
  blackholeDevice: string;
  ttsProvider: TTSProvider;
}

/**
 * Audio bridge between Discord Web and the local audio system
 *
 * Capture: CDP → inject Web Audio script → extract PCM → emit 'audio' events
 * Playback: TTS provider → wav/mp3 → sox → BlackHole virtual device → Discord mic
 */
export class AudioBridge extends EventEmitter {
  private config: AudioBridgeConfig;
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private capturing = false;
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private playbackProcess: ChildProcess | null = null;
  private tmpDir: string;

  constructor(config: AudioBridgeConfig) {
    super();
    this.config = config;
    this.tmpDir = mkdtempSync(join(tmpdir(), 'discord-voice-'));
  }

  /**
   * Attach to a page for audio capture and playback
   */
  async attach(page: Page): Promise<void> {
    this.page = page;

    // Create a CDP session for audio capture
    const client = await page.createCDPSession();
    this.cdpSession = client;

    logger.info('Audio bridge attached to page');
  }

  /**
   * Start capturing tab audio via Web Audio API injection
   * Emits 'audio' events with PCM Float32 chunks
   */
  async startCapture(): Promise<void> {
    if (!this.page || this.capturing) return;

    this.capturing = true;

    // Inject audio capture script into the page
    // Note: this code runs in browser context (DOM APIs available)
    await this.page.evaluate(`(function() {
      var audioCtx = new AudioContext({ sampleRate: ${SAMPLE_RATE} });
      var destination = audioCtx.createMediaStreamDestination();

      var captureAudioElements = function() {
        var elements = document.querySelectorAll('audio, video');
        elements.forEach(function(el) {
          try {
            var source = audioCtx.createMediaElementSource(el);
            source.connect(destination);
            source.connect(audioCtx.destination);
          } catch(e) {
            // Already captured or CORS restricted
          }
        });
      };

      captureAudioElements();

      var observer = new MutationObserver(function() { captureAudioElements(); });
      observer.observe(document.body, { childList: true, subtree: true });

      var processor = audioCtx.createScriptProcessor(4096, 1, 1);
      var source = audioCtx.createMediaStreamSource(destination.stream);
      source.connect(processor);
      processor.connect(audioCtx.destination);

      window.__audioBuffer = [];
      window.__audioCapturing = true;

      processor.onaudioprocess = function(e) {
        if (!window.__audioCapturing) return;
        var data = e.inputBuffer.getChannelData(0);
        var copy = new Float32Array(data.length);
        copy.set(data);
        window.__audioBuffer.push(copy);
      };
    })()`);

    // Poll for captured audio chunks
    this.captureInterval = setInterval(() => {
      void this.collectAudioChunks();
    }, CAPTURE_INTERVAL_MS);

    logger.info('Audio capture started');
  }

  /**
   * Stop capturing tab audio
   */
  async stopCapture(): Promise<void> {
    if (!this.capturing) return;

    this.capturing = false;

    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    if (this.page) {
      try {
        await this.page.evaluate('window.__audioCapturing = false');
      } catch {
        // Page might be closed
      }
    }

    logger.info('Audio capture stopped');
  }

  /**
   * Synthesize text to speech and play it to the BlackHole virtual device
   */
  async speak(text: string): Promise<void> {
    logger.info(`Speaking: "${text.substring(0, 60)}..."`);

    try {
      // Generate audio via TTS provider
      const audioBuffer = await this.config.ttsProvider.synthesize(text);

      // Write to temp file
      const tmpFile = join(this.tmpDir, `tts-${Date.now()}.mp3`);
      writeFileSync(tmpFile, audioBuffer);

      // Play to BlackHole device using sox (or ffplay as fallback)
      await this.playToBlackhole(tmpFile);

      // Clean up temp file
      try {
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }

      logger.debug('Speech playback complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Speech playback failed: ${message}`);
      throw error;
    }
  }

  /**
   * Play an audio file to the BlackHole virtual audio device
   */
  private async playToBlackhole(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const device = this.config.blackholeDevice;

      // sox: play file to coreaudio output device
      this.playbackProcess = spawn('sox', [filePath, '-t', 'coreaudio', device], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.playbackProcess.on('close', (code) => {
        this.playbackProcess = null;
        if (code === 0) {
          resolve();
        } else {
          // Fallback to ffplay
          logger.debug('sox failed, trying ffplay...');
          const ffplay = spawn(
            'ffplay',
            ['-nodisp', '-autoexit', '-f', 'coreaudio', '-i', filePath],
            { stdio: ['ignore', 'pipe', 'pipe'] }
          );
          ffplay.on('close', (ffCode) => {
            if (ffCode === 0) {
              resolve();
            } else {
              reject(new Error(`Audio playback failed (sox: ${code}, ffplay: ${ffCode})`));
            }
          });
          ffplay.on('error', () => {
            reject(new Error('Neither sox nor ffplay available for audio playback'));
          });
        }
      });

      this.playbackProcess.on('error', (err) => {
        this.playbackProcess = null;
        reject(err);
      });
    });
  }

  /**
   * Stop any ongoing playback
   */
  stopPlayback(): void {
    if (this.playbackProcess) {
      this.playbackProcess.kill('SIGTERM');
      this.playbackProcess = null;
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    await this.stopCapture();
    this.stopPlayback();

    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }

    this.page = null;
    logger.debug('Audio bridge disposed');
  }

  /**
   * Collect buffered audio chunks from the page
   */
  private async collectAudioChunks(): Promise<void> {
    if (!this.page || !this.capturing) return;

    try {
      const chunks = await this.page.evaluate(`(function() {
        var buffer = window.__audioBuffer;
        if (!buffer || buffer.length === 0) return null;

        var totalLength = 0;
        for (var i = 0; i < buffer.length; i++) totalLength += buffer[i].length;
        var combined = new Float32Array(totalLength);
        var offset = 0;
        for (var i = 0; i < buffer.length; i++) {
          combined.set(buffer[i], offset);
          offset += buffer[i].length;
        }
        window.__audioBuffer = [];
        return Array.from(combined);
      })()`) as number[] | null;

      if (chunks && chunks.length > 0) {
        // Check if there's actual audio (not silence)
        let maxAmplitude = 0;
        for (const v of chunks) {
          const abs = Math.abs(v);
          if (abs > maxAmplitude) maxAmplitude = abs;
        }

        if (maxAmplitude > 0.01) {
          // Convert to Int16 PCM for STT compatibility
          const float32 = new Float32Array(chunks);
          const pcmBuffer = this.float32ToInt16(float32);
          this.emit('audio', pcmBuffer);
        }
      }
    } catch {
      // Page might be navigating, ignore
    }
  }

  /**
   * Convert Float32 audio samples to Int16 PCM buffer
   */
  private float32ToInt16(float32: Float32Array): Buffer {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return Buffer.from(int16.buffer);
  }
}

export { SAMPLE_RATE, CHANNELS };
