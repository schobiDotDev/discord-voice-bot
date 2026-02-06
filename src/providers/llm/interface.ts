/**
 * Chat message structure
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM provider interface
 */
export interface LLMProvider {
  /**
   * Provider name for logging and identification
   */
  readonly name: string;

  /**
   * Generate a response from the language model
   * @param messages Conversation history
   * @returns Generated response text
   */
  chat(messages: ChatMessage[]): Promise<string>;

  /**
   * Check if the provider is properly configured and available
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Common LLM configuration options
 */
export interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}
