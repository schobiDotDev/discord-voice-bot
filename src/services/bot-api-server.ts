import express, { type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { logger } from '../utils/logger.js';
import { voicePlayer } from '../voice/index.js';
import type { TextBridgeService } from './text-bridge.js';

/**
 * Lightweight API server for bot mode.
 * Accepts /speak from OpenClaw plugin to play TTS in the active voice channel.
 */
export class BotApiServer {
  private app: express.Application;
  private server: Server | null = null;
  private port: number;
  private textBridge: TextBridgeService | null;

  constructor(port: number, textBridge: TextBridgeService | null = null) {
    this.port = port;
    this.textBridge = textBridge;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(this.app);
      this.server.listen(this.port, () => {
        logger.info(`Bot API server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Bot API server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private setupRoutes(): void {
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', mode: 'bot' });
    });

    this.app.get('/status', (_req: Request, res: Response) => {
      res.json({
        mode: 'bot',
        playing: voicePlayer.playing,
        timestamp: new Date().toISOString(),
      });
    });

    this.app.post('/speak', async (req: Request, res: Response) => {
      const { text } = req.body as { text?: string };
      if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
      }

      try {
        // Log agent response to text channel
        if (this.textBridge) {
          this.textBridge.log(`🤖 **OpenClaw:**\n> ${text}`).catch(() => {});
        }

        await voicePlayer.speak(text);
        res.json({ status: 'spoken', text });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Speak failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    });
  }
}
