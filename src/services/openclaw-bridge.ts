import { logger } from '../utils/logger.js';

export interface TranscriptionPayload {
  text: string;
  userId: string;
  userName: string;
  channelId: string;
  guildId: string;
}

/**
 * Sends voice transcriptions to the OpenClaw bridge endpoint.
 * Fire-and-forget — responses come back asynchronously via /speak.
 */
export class OpenClawBridgeService {
  private bridgeUrl: string;

  constructor(bridgeUrl: string) {
    this.bridgeUrl = bridgeUrl;
    logger.info(`OpenClaw bridge configured: ${bridgeUrl}`);
  }

  /**
   * Send a transcription to OpenClaw
   */
  async sendTranscription(payload: TranscriptionPayload): Promise<void> {
    try {
      const res = await fetch(this.bridgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        logger.error(`OpenClaw bridge error: ${res.status} ${res.statusText}`);
      } else {
        logger.debug(`Transcription sent to OpenClaw bridge`, {
          userId: payload.userId,
          text: payload.text.substring(0, 80),
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`OpenClaw bridge request failed: ${msg}`);
    }
  }
}
