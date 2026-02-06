import { createReadStream } from 'node:fs';
import FormData from 'form-data';
import { request } from 'undici';
import { logger } from '../../utils/logger.js';
import type { STTProvider, STTConfig } from './interface.js';

/**
 * OpenAI Whisper API provider for Speech-to-Text
 * Compatible with OpenAI API and self-hosted alternatives
 */
export class WhisperAPIProvider implements STTProvider {
  readonly name = 'whisper-api';
  private config: STTConfig;

  constructor(config: STTConfig) {
    this.config = config;
  }

  async transcribe(audioPath: string): Promise<string> {
    const formData = new FormData();
    formData.append('model', this.config.model);
    formData.append('file', createReadStream(audioPath), {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg',
    });

    if (this.config.language) {
      formData.append('language', this.config.language);
    }

    const headers: Record<string, string> = {
      ...formData.getHeaders(),
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    try {
      const response = await request(this.config.apiUrl, {
        method: 'POST',
        headers,
        body: formData.getBuffer(),
      });

      if (response.statusCode !== 200) {
        const errorBody = await response.body.text();
        throw new Error(`STT API error (${response.statusCode}): ${errorBody}`);
      }

      const data = (await response.body.json()) as { text: string };
      logger.debug(`Whisper API transcription: "${data.text}"`);
      return data.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Whisper API transcription failed: ${message}`);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    // Simple availability check - verify API key is configured
    // A full health check would require a test transcription
    return Boolean(this.config.apiUrl);
  }
}
