import { config } from '../../config.js';
import logger from '../../utils/logger.js';
import type { STTProvider } from './interface.js';
import { WhisperAPIProvider } from './whisper-api.js';
import { WhisperLocalProvider } from './whisper-local.js';

export type { STTProvider, STTConfig, TranscriptionResult } from './interface.js';

/**
 * Create and return the configured STT provider
 */
export function createSTTProvider(): STTProvider {
  const { provider, apiUrl, apiKey, model } = config.stt;

  logger.info(`Initializing STT provider: ${provider}`);

  switch (provider) {
    case 'whisper-api':
      return new WhisperAPIProvider({ apiUrl, apiKey, model });

    case 'whisper-local':
      return new WhisperLocalProvider({ apiUrl, apiKey, model });

    default:
      throw new Error(`Unknown STT provider: ${provider}`);
  }
}
