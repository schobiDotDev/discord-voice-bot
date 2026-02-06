import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import type { TTSProvider } from './interface.js';
import { OpenAITTSProvider } from './openai-tts.js';
import { SherpaOnnxProvider } from './sherpa-onnx.js';
import { ElevenLabsProvider } from './elevenlabs.js';

export type { TTSProvider, TTSConfig, AudioFormat } from './interface.js';

/**
 * Create and return the configured TTS provider
 */
export function createTTSProvider(): TTSProvider {
  const { provider, apiUrl, apiKey, model, voice } = config.tts;

  logger.info(`Initializing TTS provider: ${provider}`);

  switch (provider) {
    case 'openai':
      return new OpenAITTSProvider({ apiUrl, apiKey, model, voice });

    case 'sherpa-onnx':
      return new SherpaOnnxProvider({ apiUrl, apiKey, model, voice });

    case 'elevenlabs':
      return new ElevenLabsProvider({
        apiUrl: apiUrl || 'https://api.elevenlabs.io/v1',
        apiKey,
        model,
        voice,
      });

    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}
