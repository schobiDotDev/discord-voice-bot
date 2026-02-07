import { createReadStream } from 'node:fs';
import FormData from 'form-data';
import { request } from 'undici';
import { logger } from '../../utils/logger.js';
import type { STTProvider, STTConfig } from './interface.js';

/**
 * Local Whisper provider for Speech-to-Text
 * Compatible with whisper.cpp server and similar local implementations
 */
export class WhisperLocalProvider implements STTProvider {
  readonly name = 'whisper-local';
  private config: STTConfig;

  constructor(config: STTConfig) {
    this.config = config;
  }

  async transcribe(audioPath: string, language?: string): Promise<string> {
    // Detect file type from extension
    const isWav = audioPath.toLowerCase().endsWith('.wav');
    const mimeType = isWav ? 'audio/wav' : 'audio/mpeg';
    const filename = isWav ? 'audio.wav' : 'audio.mp3';
    
    const formData = new FormData();
    formData.append('file', createReadStream(audioPath), {
      filename,
      contentType: mimeType,
    });

    // Local whisper.cpp typically uses 'temperature' and 'response_format' params
    formData.append('temperature', '0.0');
    formData.append('response_format', 'json');

    // Use provided language or fall back to config
    const lang = language ?? this.config.language;
    if (lang) {
      formData.append('language', lang);
    }

    try {
      const response = await request(this.config.apiUrl, {
        method: 'POST',
        headers: formData.getHeaders(),
        body: formData.getBuffer(),
      });

      if (response.statusCode !== 200) {
        const errorBody = await response.body.text();
        throw new Error(`Local STT error (${response.statusCode}): ${errorBody}`);
      }

      const data = (await response.body.json()) as { text: string };
      logger.debug(`Local Whisper transcription: "${data.text}"`);
      return data.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Local Whisper transcription failed: ${message}`);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Try to reach the local server
      const response = await request(this.config.apiUrl.replace('/inference', '/health'), {
        method: 'GET',
      });
      return response.statusCode === 200;
    } catch {
      return false;
    }
  }
}
