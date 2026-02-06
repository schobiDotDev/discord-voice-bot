import { request } from 'undici';
import { logger } from '../../utils/logger.js';
import type { TTSProvider, TTSConfig } from './interface.js';

/**
 * ElevenLabs TTS provider
 * High-quality voice synthesis
 */
export class ElevenLabsProvider implements TTSProvider {
  readonly name = 'elevenlabs';
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  async synthesize(text: string): Promise<Buffer> {
    const url = `${this.config.apiUrl}/text-to-speech/${this.config.voice}`;

    try {
      const response = await request(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey ?? '',
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: this.config.model ?? 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      if (response.statusCode !== 200) {
        const errorBody = await response.body.text();
        throw new Error(`ElevenLabs TTS error (${response.statusCode}): ${errorBody}`);
      }

      const arrayBuffer = await response.body.arrayBuffer();
      logger.debug(`ElevenLabs TTS synthesized ${text.length} chars`);
      return Buffer.from(arrayBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`ElevenLabs TTS synthesis failed: ${message}`);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config.apiKey);
  }
}
