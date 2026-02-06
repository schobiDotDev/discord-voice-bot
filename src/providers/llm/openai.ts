import { request } from 'undici';
import { logger } from '../../utils/logger.js';
import type { LLMProvider, LLMConfig, ChatMessage } from './interface.js';

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * OpenAI provider for language model interactions
 * Compatible with OpenAI API and any OpenAI-compatible endpoint
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.config.apiUrl}/chat/completions`;

    try {
      const response = await request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature ?? 0.7,
        }),
      });

      if (response.statusCode !== 200) {
        const errorBody = await response.body.text();
        throw new Error(`OpenAI API error (${response.statusCode}): ${errorBody}`);
      }

      const data = (await response.body.json()) as OpenAIResponse;
      const content = data.choices[0]?.message?.content;

      if (!content) {
        throw new Error('No response content from OpenAI');
      }

      logger.debug(`OpenAI response: "${content.substring(0, 100)}..."`);
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`OpenAI chat failed: ${message}`);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config.apiKey && this.config.apiUrl);
  }
}
