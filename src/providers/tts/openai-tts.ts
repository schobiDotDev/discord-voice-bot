import { request } from 'undici';
import logger from '../../utils/logger.js';
import type { TTSProvider, TTSConfig } from './interface.js';

/**
 * OpenAI TTS provider
 * Compatible with OpenAI API and any OpenAI-compatible TTS endpoint
 */
export class OpenAITTSProvider implements TTSProvider {
  readonly name = 'openai-tts';
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  async synthesize(text: string): Promise<Buffer> {
    try {
      const response = await request(this.config.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model ?? 'tts-1',
          input: text,
          voice: this.config.voice,
          response_format: 'mp3',
          speed: this.config.speed ?? 1.0,
        }),
      });

      if (response.statusCode !== 200) {
        const errorBody = await response.body.text();
        throw new Error(`OpenAI TTS error (${response.statusCode}): ${errorBody}`);
      }

      const arrayBuffer = await response.body.arrayBuffer();
      logger.debug(`OpenAI TTS synthesized ${text.length} chars`);
      return Buffer.from(arrayBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`OpenAI TTS synthesis failed: ${message}`);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config.apiKey && this.config.apiUrl);
  }
}
