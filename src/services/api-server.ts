import express, { type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../modes/browser/logger.js';
import type { CallManager, CallState } from '../modes/browser/call-manager.js';

export interface ApiServerConfig {
  port: number;
}

/**
 * REST API + WebSocket server for browser mode control
 *
 * REST endpoints:
 *   POST /call/:userId  — Start a call to a user
 *   POST /answer        — Answer an incoming call
 *   POST /hangup        — Hang up the current call
 *   POST /speak         — Speak text via TTS (body: { text: string })
 *   GET  /status        — Get current call state
 *
 * WebSocket /ws:
 *   Broadcasts live events: { type: 'transcription' | 'response' | 'stateChange', data: ... }
 */
export class ApiServer {
  private app: express.Application;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private callManager: CallManager;
  private config: ApiServerConfig;

  constructor(callManager: CallManager, config: ApiServerConfig) {
    this.callManager = callManager;
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
    this.setupCallManagerEvents();
  }

  /**
   * Start the API server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(this.app);

      // WebSocket server on the same HTTP server
      this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

      this.wss.on('connection', (ws) => {
        logger.info('WebSocket client connected');

        // Send current state on connect
        ws.send(
          JSON.stringify({
            type: 'stateChange',
            data: this.callManager.getState(),
          })
        );

        ws.on('close', () => {
          logger.debug('WebSocket client disconnected');
        });
      });

      this.server.listen(this.config.port, () => {
        logger.info(`API server listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the API server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close();
        this.wss = null;
      }
      if (this.server) {
        this.server.close(() => {
          logger.info('API server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Broadcast a message to all connected WebSocket clients
   */
  private broadcast(type: string, data: unknown): void {
    if (!this.wss) return;

    const message = JSON.stringify({ type, data });
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });

    // Get current status
    this.app.get('/status', (_req: Request, res: Response) => {
      res.json({
        state: this.callManager.getState(),
        timestamp: new Date().toISOString(),
      });
    });

    // Start a call
    this.app.post('/call/:userId', async (req: Request, res: Response) => {
      const userId = req.params['userId'] as string | undefined;
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      try {
        const success = await this.callManager.startCall(userId);
        if (success) {
          res.json({ status: 'calling', userId });
        } else {
          res.status(409).json({ error: 'Failed to start call', state: this.callManager.getState() });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Answer incoming call
    this.app.post('/answer', async (_req: Request, res: Response) => {
      try {
        const success = await this.callManager.answerCall();
        if (success) {
          res.json({ status: 'connected' });
        } else {
          res.status(409).json({ error: 'No incoming call to answer' });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Hang up
    this.app.post('/hangup', async (_req: Request, res: Response) => {
      try {
        await this.callManager.hangUp();
        res.json({ status: 'idle' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Speak text
    this.app.post('/speak', async (req: Request, res: Response) => {
      const { text } = req.body as { text?: string };
      if (!text) {
        res.status(400).json({ error: 'text is required in request body' });
        return;
      }

      try {
        await this.callManager.speak(text);
        res.json({ status: 'spoken', text });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });
  }

  private setupCallManagerEvents(): void {
    this.callManager.on('stateChange', (state: CallState) => {
      this.broadcast('stateChange', state);
    });

    this.callManager.on('transcription', (text: string) => {
      this.broadcast('transcription', text);
    });

    this.callManager.on('response', (text: string) => {
      this.broadcast('response', text);
    });

    this.callManager.on('error', (error: Error) => {
      this.broadcast('error', error.message);
    });
  }
}
