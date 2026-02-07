import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import type { WakeWordProvider } from './interface.js';
import { OpenWakeWordProvider } from './openwakeword.js';

export type { WakeWordProvider, WakeWordResult, WakeWordConfig } from './interface.js';

/**
 * Create and return the configured wake word provider.
 * Returns null if wake word detection is disabled.
 */
export function createWakeWordProvider(): WakeWordProvider | null {
  const { provider, modelPath, keywords, sensitivity } = config.wakeWord;

  if (provider === 'none') {
    logger.info('Wake word detection disabled');
    return null;
  }

  logger.info(`Initializing wake word provider: ${provider}`);

  switch (provider) {
    case 'openwakeword':
      return new OpenWakeWordProvider({
        keywords,
        sensitivity,
        modelPath,
      });

    default:
      throw new Error(`Unknown wake word provider: ${provider}`);
  }
}
