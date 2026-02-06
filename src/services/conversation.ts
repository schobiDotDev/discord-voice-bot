import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { LLMProvider, ChatMessage } from '../providers/llm/index.js';

interface ConversationState {
  messages: ChatMessage[];
  freeMode: boolean;
}

/**
 * Manages conversation history and LLM interactions
 */
export class ConversationService {
  private conversations: Map<string, ConversationState> = new Map();
  private llmProvider: LLMProvider;

  constructor(llmProvider: LLMProvider) {
    this.llmProvider = llmProvider;
  }

  /**
   * Get or create a conversation for a user
   */
  private getConversation(userId: string, freeMode = false): ConversationState {
    let conversation = this.conversations.get(userId);

    if (!conversation) {
      conversation = {
        messages: [],
        freeMode,
      };
      this.conversations.set(userId, conversation);
    }

    return conversation;
  }

  /**
   * Send a message and get a response from the LLM
   */
  async chat(userId: string, userMessage: string, freeMode = false): Promise<string> {
    const conversation = this.getConversation(userId, freeMode);

    // Initialize with system prompt if this is a new conversation
    if (conversation.messages.length === 0) {
      const systemPrompt = freeMode ? config.llm.systemPromptFree : config.llm.systemPrompt;
      conversation.messages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    // Add user message
    conversation.messages.push({
      role: 'user',
      content: userMessage,
    });

    // Trim to memory size (keeping system message)
    while (conversation.messages.length > config.llm.memorySize + 1) {
      // Remove oldest non-system message
      conversation.messages.splice(1, 1);
    }

    try {
      const response = await this.llmProvider.chat(conversation.messages);

      // Check for ignore signals
      if (response.includes('IGNORING')) {
        logger.debug(`LLM chose to ignore message from user ${userId}`);
        // Remove the user message since we're ignoring
        conversation.messages.pop();
        return '';
      }

      // Add assistant response to history
      conversation.messages.push({
        role: 'assistant',
        content: response,
      });

      logger.info(`LLM response for user ${userId}: "${response.substring(0, 100)}..."`);
      return response;
    } catch (error) {
      // Remove failed user message from history
      conversation.messages.pop();
      throw error;
    }
  }

  /**
   * Reset conversation history for a user
   */
  reset(userId: string): void {
    this.conversations.delete(userId);
    logger.info(`Conversation reset for user ${userId}`);
  }

  /**
   * Reset all conversations
   */
  resetAll(): void {
    this.conversations.clear();
    logger.info('All conversations reset');
  }

  /**
   * Check if user has an active conversation
   */
  hasConversation(userId: string): boolean {
    return this.conversations.has(userId);
  }

  /**
   * Get conversation history for a user
   */
  getHistory(userId: string): ChatMessage[] {
    return this.conversations.get(userId)?.messages ?? [];
  }
}
