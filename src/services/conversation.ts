import { logger } from '../utils/logger.js';
import type { TextBridgeService } from './text-bridge.js';

/**
 * Manages voice conversations by bridging to the text channel
 */
export class ConversationService {
  private textBridge: TextBridgeService;
  private usernames: Map<string, string> = new Map();

  constructor(textBridge: TextBridgeService) {
    this.textBridge = textBridge;
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
  async chat(userId: string, userMessage: string): Promise<string> {
    const username = this.getUsername(userId);

    try {
      const response = await this.textBridge.postAndWaitForResponse(userId, username, userMessage);

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
}
