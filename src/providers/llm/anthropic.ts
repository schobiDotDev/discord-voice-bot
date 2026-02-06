import { request } from 'undici';
import { logger } from '../../utils/logger.js';
import type { LLMProvider, LLMConfig, ChatMessage } from './interface.js';

interface AnthropicResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

/**
 * Anthropic provider for language model interactions
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = 'https://api.anthropic.com/v1/messages';

    // Extract system message and convert format
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    try {
      const response = await request(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? 1024,
          system: systemMessage?.content,
          messages: conversationMessages,
        }),
      });

      if (response.statusCode !== 200) {
        const errorBody = await response.body.text();
        throw new Error(`Anthropic API error (${response.statusCode}): ${errorBody}`);
      }

      const data = (await response.body.json()) as AnthropicResponse;
      const textContent = data.content.find((c) => c.type === 'text');

      if (!textContent) {
        throw new Error('No text response from Anthropic');
      }

      logger.debug(`Anthropic response: "${textContent.text.substring(0, 100)}..."`);
      return textContent.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Anthropic chat failed: ${message}`);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config.apiKey);
  }
}
