import { Client, Events, Message, TextChannel, type Snowflake } from 'discord.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { EventEmitter } from 'events';

interface PendingRequest {
  userId: string;
  username: string;
  messageId: Snowflake;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface TranscriptionMetadata {
  userId: string;
  username: string;
  transcription: string;
  durationSeconds: number;
  conversationContext?: string;
}

/**
 * Text Bridge Service
 * Bridges voice transcriptions to a text channel and waits for responses
 * from the configured bot (e.g., OpenClaw)
 */
export class TextBridgeService extends EventEmitter {
  private client: Client;
  private textChannel: TextChannel | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private initialized = false;

  constructor(client: Client) {
    super();
    this.client = client;
  }

  /**
   * Initialize the text bridge
   * Should be called after the Discord client is ready
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const channelId = config.textBridge.channelId;
    if (!channelId) {
      throw new Error('TEXT_CHANNEL_ID is not configured');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      throw new Error(`Channel ${channelId} is not a valid text channel`);
    }

    this.textChannel = channel;
    this.setupMessageListener();
    this.initialized = true;

    logger.info(`Text bridge initialized`, {
      channelId,
      channelName: channel.name,
      responderId: config.textBridge.responderBotId,
    });
  }

  /**
   * Format a transcription message with user metadata
   */
  private formatTranscriptionMessage(metadata: TranscriptionMetadata): string {
    const { userId, username, transcription, durationSeconds, conversationContext } = metadata;
    const duration = durationSeconds.toFixed(1);

    let message = `🎤 **${username}** (ID: ${userId}) | Dauer: ${duration}s\n> ${transcription}`;

    // Add conversation context if available
    if (conversationContext) {
      message += `\n\n${conversationContext}`;
    }

    return message;
  }

  /**
   * Post a voice transcription and wait for a response
   */
  async postAndWaitForResponse(metadata: TranscriptionMetadata): Promise<string> {
    if (!this.textChannel) {
      throw new Error('Text bridge not initialized');
    }

    const { userId, username } = metadata;

    // Format the message with metadata
    const formattedMessage = this.formatTranscriptionMessage(metadata);

    // Post the transcription to the text channel
    const message = await this.textChannel.send(formattedMessage);

    logger.info(`Posted voice transcription`, {
      userId,
      username,
      messageId: message.id,
      duration: metadata.durationSeconds,
      transcription: metadata.transcription.substring(0, 100),
    });

    // Create a promise that resolves when we get a response
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(userId);
        logger.warn(`Response timeout for user ${username}`, { userId });
        reject(new Error('Response timeout'));
      }, config.textBridge.responseTimeout);

      this.pendingRequests.set(userId, {
        userId,
        username,
        messageId: message.id,
        resolve,
        reject,
        timeoutId,
      });
    });
  }

  /**
   * Cancel a pending request (e.g., user interrupted)
   */
  cancelPendingRequest(userId: string): void {
    const request = this.pendingRequests.get(userId);
    if (request) {
      clearTimeout(request.timeoutId);
      this.pendingRequests.delete(userId);
      logger.debug(`Cancelled pending request for user ${userId}`);
    }
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(): void {
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timeoutId);
      request.reject(new Error('Request cancelled'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Check if there's a pending request for a user
   */
  hasPendingRequest(userId: string): boolean {
    return this.pendingRequests.has(userId);
  }

  private setupMessageListener(): void {
    this.client.on(Events.MessageCreate, (message: Message) => {
      this.handleMessage(message);
    });
  }

  private handleMessage(message: Message): void {
    // Only process messages in our configured channel
    if (message.channelId !== config.textBridge.channelId) return;

    // Only process messages from the responder bot
    if (message.author.id !== config.textBridge.responderBotId) return;

    // Ignore if no pending requests
    if (this.pendingRequests.size === 0) return;

    logger.debug(`Received response from responder bot`, {
      authorId: message.author.id,
      content: message.content.substring(0, 100),
    });

    // Try to find a matching pending request
    // The responder might reply to a specific user or just send a general response
    // We'll match based on mentions or take the oldest pending request

    // Check for user mentions in the response
    const mentionedUserId = message.mentions.users.first()?.id;

    let matchedUserId: string | undefined;
    let matchedRequest: PendingRequest | undefined;

    if (mentionedUserId && this.pendingRequests.has(mentionedUserId)) {
      // Response mentions a specific user we're waiting for
      matchedUserId = mentionedUserId;
      matchedRequest = this.pendingRequests.get(mentionedUserId);
    } else if (this.pendingRequests.size === 1) {
      // Only one pending request, assume it's for them
      const entry = this.pendingRequests.entries().next().value as [string, PendingRequest];
      matchedUserId = entry[0];
      matchedRequest = entry[1];
    } else {
      // Multiple pending requests and no clear match
      // Take the oldest one (first in map order)
      const entry = this.pendingRequests.entries().next().value as [string, PendingRequest];
      matchedUserId = entry[0];
      matchedRequest = entry[1];
    }

    if (matchedRequest && matchedUserId) {
      clearTimeout(matchedRequest.timeoutId);
      this.pendingRequests.delete(matchedUserId);

      // Clean the response (remove mentions, etc.)
      let response = message.content;

      // Remove user mentions from response
      response = response.replace(/<@!?\d+>/g, '').trim();

      logger.info(`Response received for user ${matchedRequest.username}`, {
        userId: matchedRequest.userId,
        response: response.substring(0, 100),
      });

      matchedRequest.resolve(response);
    }
  }
}
