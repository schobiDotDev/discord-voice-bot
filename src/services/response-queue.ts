import { logger } from '../utils/logger.js';
import { EventEmitter } from 'node:events';

export interface QueuedResponse {
  userId: string;
  username: string;
  text: string;
  timestamp: number;
  priority: number; // Lower = higher priority
}

export type ResponseInterruptHandler = () => void;

/**
 * Manages a queue of responses for multiple users.
 * Handles interrupts when a new user speaks while a response is being played.
 */
export class ResponseQueue extends EventEmitter {
  private queue: QueuedResponse[] = [];
  private isPlaying = false;
  private currentResponse: QueuedResponse | null = null;
  private interruptHandlers = new Set<ResponseInterruptHandler>();

  /**
   * Add a response to the queue.
   * If a response for the same user is already queued, replace it.
   */
  enqueue(response: QueuedResponse): void {
    // Remove any existing responses from the same user (latest wins)
    this.queue = this.queue.filter((r) => r.userId !== response.userId);

    this.queue.push(response);
    this.queue.sort((a, b) => a.priority - b.priority || a.timestamp - b.timestamp);

    logger.debug(`Response queued for user ${response.username}`, {
      userId: response.userId,
      queueLength: this.queue.length,
      priority: response.priority,
    });

    // Start processing if not already playing
    if (!this.isPlaying) {
      this.emit('ready');
    }
  }

  /**
   * Get the next response to play.
   */
  dequeue(): QueuedResponse | null {
    if (this.queue.length === 0) return null;

    const response = this.queue.shift()!;
    this.currentResponse = response;

    logger.debug(`Dequeued response for user ${response.username}`, {
      userId: response.userId,
      remaining: this.queue.length,
    });

    return response;
  }

  /**
   * Mark the current response as complete.
   */
  markComplete(): void {
    if (this.currentResponse) {
      logger.debug(`Response completed for user ${this.currentResponse.username}`, {
        userId: this.currentResponse.userId,
      });
      this.currentResponse = null;
    }

    this.isPlaying = false;

    // Notify if more items in queue
    if (this.queue.length > 0) {
      this.emit('ready');
    }
  }

  /**
   * Cancel all responses for a specific user.
   */
  cancelUser(userId: string): boolean {
    const lengthBefore = this.queue.length;
    this.queue = this.queue.filter((r) => r.userId !== userId);

    const cancelled = lengthBefore - this.queue.length;
    if (cancelled > 0) {
      logger.debug(`Cancelled ${cancelled} queued response(s) for user ${userId}`);
      return true;
    }

    // Check if currently playing response is from this user
    if (this.currentResponse && this.currentResponse.userId === userId) {
      logger.debug(`Interrupting current response for user ${userId}`);
      this.triggerInterrupt();
      return true;
    }

    return false;
  }

  /**
   * Cancel all queued responses and interrupt current playback.
   */
  cancelAll(): void {
    const queuedCount = this.queue.length;
    this.queue = [];

    if (queuedCount > 0) {
      logger.debug(`Cancelled ${queuedCount} queued response(s)`);
    }

    if (this.isPlaying) {
      this.triggerInterrupt();
    }
  }

  /**
   * Register an interrupt handler (called when current response needs to be stopped).
   */
  onInterrupt(handler: ResponseInterruptHandler): void {
    this.interruptHandlers.add(handler);
  }

  /**
   * Remove an interrupt handler.
   */
  offInterrupt(handler: ResponseInterruptHandler): void {
    this.interruptHandlers.delete(handler);
  }

  /**
   * Trigger all registered interrupt handlers.
   */
  private triggerInterrupt(): void {
    for (const handler of this.interruptHandlers) {
      try {
        handler();
      } catch (error) {
        logger.error(`Interrupt handler error: ${error}`);
      }
    }
  }

  /**
   * Check if queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Get queue length.
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if currently playing a response.
   */
  get playing(): boolean {
    return this.isPlaying;
  }

  /**
   * Set playing state.
   */
  setPlaying(playing: boolean): void {
    this.isPlaying = playing;
  }

  /**
   * Get current response being played.
   */
  getCurrent(): QueuedResponse | null {
    return this.currentResponse;
  }

  /**
   * Get all queued responses (for debugging).
   */
  getAll(): QueuedResponse[] {
    return [...this.queue];
  }
}
