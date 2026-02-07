import { request } from 'undici';
import { logger } from '../../utils/logger.js';
import type { TTSProvider, TTSConfig } from './interface.js';

/**
 * Sherpa-ONNX TTS provider
 * Local, free TTS using sherpa-onnx models
 */
export class SherpaOnnxProvider implements TTSProvider {
  readonly name = 'sherpa-onnx';
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  async synthesize(text: string): Promise<Buffer> {
    try {
      // Sherpa-ONNX server with OpenAI-compatible API
      const response = await request(`${this.config.apiUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: text,
          voice: this.config.voice,
          response_format: 'wav',
          speed: this.config.speed ?? 1.0,
        }),
      });

      if (response.statusCode !== 200) {
        const errorBody = await response.body.text();
        throw new Error(`Sherpa-ONNX TTS error (${response.statusCode}): ${errorBody}`);
      }

      const arrayBuffer = await response.body.arrayBuffer();
      logger.debug(`Sherpa-ONNX TTS synthesized ${text.length} chars`);
      return Buffer.from(arrayBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Sherpa-ONNX TTS synthesis failed: ${message}`);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await request(`${this.config.apiUrl}/health`, {
        method: 'GET',
      });
      return response.statusCode === 200;
    } catch {
      return false;
    }
  }
}
