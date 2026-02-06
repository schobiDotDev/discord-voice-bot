import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import type { LLMProvider } from './interface.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

export type { LLMProvider, LLMConfig, ChatMessage } from './interface.js';

/**
 * Create and return the configured LLM provider
 */
export function createLLMProvider(): LLMProvider {
  const { provider, openai, anthropic } = config.llm;

  logger.info(`Initializing LLM provider: ${provider}`);

  switch (provider) {
    case 'openai':
      if (!openai?.apiKey) {
        throw new Error('OpenAI API key not configured');
      }
      return new OpenAIProvider({
        apiUrl: openai.apiUrl,
        apiKey: openai.apiKey,
        model: openai.model,
      });

    case 'anthropic':
      if (!anthropic?.apiKey) {
        throw new Error('Anthropic API key not configured');
      }
      return new AnthropicProvider({
        apiUrl: 'https://api.anthropic.com/v1',
        apiKey: anthropic.apiKey,
        model: anthropic.model,
      });

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
