import { logger } from '../utils/logger.js';
import type { TextBridgeService, TranscriptionMetadata } from './text-bridge.js';
import { ConversationMemory } from './conversation-memory.js';

/**
 * Manages voice conversations by bridging to the text channel
 */
export class ConversationService {
  private textBridge: TextBridgeService;
  private usernames: Map<string, string> = new Map();
  private memory: ConversationMemory;

  constructor(textBridge: TextBridgeService) {
    this.textBridge = textBridge;
    this.memory = new ConversationMemory();
  }

  /**
   * Set the username for a user (for formatting messages)
   */
  setUsername(userId: string, username: string): void {
    this.usernames.set(userId, username);
  }

  /**
   * Get stored username or fallback to userId
   */
  getUsername(userId: string): string {
    return this.usernames.get(userId) ?? userId;
  }

  /**
   * Send a message and wait for a response via the text bridge
   */
  async chat(userId: string, userMessage: string, durationSeconds: number): Promise<string> {
    const username = this.getUsername(userId);

    // Store user message in memory
    this.memory.addMessage(userId, 'user', userMessage);

    // Build transcription with conversation context
    const historyContext = this.memory.formatHistoryContext(userId);
    const transcriptionWithContext = historyContext
      ? `${historyContext}\n\n🎤 **Current message:** ${userMessage}`
      : userMessage;

    const metadata: TranscriptionMetadata = {
      userId,
      username,
      transcription: transcriptionWithContext,
      durationSeconds,
    };

    try {
      const response = await this.textBridge.postAndWaitForResponse(metadata);

      // Store assistant response in memory
      if (response) {
        this.memory.addMessage(userId, 'assistant', response);
      }

      logger.info(`Response for user ${username}: "${response.substring(0, 100)}..."`);
      return response;
    } catch (error) {
      if (error instanceof Error && error.message === 'Response timeout') {
        logger.warn(`No response received for user ${username}`, { userId });
        return '';
      }
      throw error;
    }
  }

  /**
   * Clear conversation memory for a user
   */
  clearMemory(userId: string): void {
    this.memory.clearHistory(userId);
    logger.info(`Cleared conversation memory for user ${userId}`);
  }

  /**
   * Cancel a pending request for a user
   */
  cancel(userId: string): void {
    this.textBridge.cancelPendingRequest(userId);
    logger.debug(`Cancelled pending request for user ${userId}`);
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(): void {
    this.textBridge.cancelAll();
    logger.info('All pending requests cancelled');
  }

  /**
   * Check if there's a pending request for a user
   */
  hasPendingRequest(userId: string): boolean {
    return this.textBridge.hasPendingRequest(userId);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.memory.dispose();
  }
}
