import { logger } from '../utils/logger.js';

export type MessageRole = 'user' | 'assistant';

export interface MemoryMessage {
  role: MessageRole;
  content: string;
  timestamp: number;
}

interface UserMemory {
  messages: MemoryMessage[];
  lastActivity: number;
}

const MAX_MESSAGES = 10;
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory conversation history store.
 * Keeps the last N messages per user with automatic TTL-based cleanup.
 */
export class ConversationMemory {
  private store: Map<string, UserMemory> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Add a message to a user's conversation history.
   */
  addMessage(userId: string, role: MessageRole, content: string): void {
    let memory = this.store.get(userId);
    if (!memory) {
      memory = { messages: [], lastActivity: Date.now() };
      this.store.set(userId, memory);
    }

    memory.messages.push({ role, content, timestamp: Date.now() });
    memory.lastActivity = Date.now();

    // Trim to max messages
    if (memory.messages.length > MAX_MESSAGES) {
      memory.messages = memory.messages.slice(-MAX_MESSAGES);
    }

    logger.debug(`Memory: added ${role} message for user ${userId} (${memory.messages.length} total)`);
  }

  /**
   * Get conversation history for a user.
   */
  getHistory(userId: string): MemoryMessage[] {
    const memory = this.store.get(userId);
    if (!memory) return [];

    // Check TTL
    if (Date.now() - memory.lastActivity > TTL_MS) {
      this.store.delete(userId);
      logger.debug(`Memory: expired history for user ${userId}`);
      return [];
    }

    return [...memory.messages];
  }

  /**
   * Clear conversation history for a user.
   */
  clearHistory(userId: string): void {
    this.store.delete(userId);
    logger.debug(`Memory: cleared history for user ${userId}`);
  }

  /**
   * Format history as a readable context string for the responder bot.
   */
  formatHistoryContext(userId: string): string {
    const history = this.getHistory(userId);
    if (history.length === 0) return '';

    const lines = history.map((msg) => {
      const prefix = msg.role === 'user' ? 'User' : 'Assistant';
      return `${prefix}: ${msg.content}`;
    });

    return `📝 **Conversation History:**\n${lines.join('\n')}`;
  }

  /**
   * Remove expired entries.
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [userId, memory] of this.store) {
      if (now - memory.lastActivity > TTL_MS) {
        this.store.delete(userId);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(`Memory: cleaned up ${removed} expired entries`);
    }
  }

  /**
   * Dispose of the memory store and stop cleanup timer.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }
}
