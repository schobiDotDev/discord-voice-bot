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
 *   POST /call/start   — Start listening for voice
 *   POST /call/:userId — Start a call (alias for /call/start)
 *   POST /answer       — Answer an incoming call (alias for /call/start)
 *   POST /hangup       — Stop listening
 *   POST /speak        — Speak text via TTS (body: { text: string })
 *   POST /listen       — Listen for a single utterance and return transcription
 *   GET  /status       — Get current state
 *   GET  /health       — Health check
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

    // Start listening (new main endpoint)
    this.app.post('/call/start', async (_req: Request, res: Response) => {
      try {
        const success = await this.callManager.startCall();
        if (success) {
          res.json({ status: 'started', state: this.callManager.getState() });
        } else {
          res.status(409).json({ error: 'Failed to start', state: this.callManager.getState() });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Start a call (legacy endpoint for compatibility)
    this.app.post('/call/:userId', async (req: Request, res: Response) => {
      const userId = req.params['userId'] as string | undefined;

      try {
        const success = await this.callManager.startCall(userId);
        if (success) {
          res.json({ status: 'started', userId, state: this.callManager.getState() });
        } else {
          res.status(409).json({ error: 'Failed to start', state: this.callManager.getState() });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Answer incoming call (alias for start in audio-only mode)
    this.app.post('/answer', async (_req: Request, res: Response) => {
      try {
        const success = await this.callManager.answerCall();
        if (success) {
          res.json({ status: 'started' });
        } else {
          res.status(409).json({ error: 'Failed to start' });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Hang up / stop listening
    this.app.post('/hangup', async (_req: Request, res: Response) => {
      try {
        await this.callManager.hangUp();
        res.json({ status: 'stopped' });
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

    // Listen for a single utterance
    this.app.post('/listen', async (_req: Request, res: Response) => {
      try {
        const transcription = await this.callManager.listenOnce();
        if (transcription) {
          res.json({ status: 'transcribed', text: transcription });
        } else {
          res.json({ status: 'no_speech', text: null });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // Conversation control endpoints
    this.app.post('/conversation/start', async (_req: Request, res: Response) => {
      try {
        const success = await this.callManager.startCall();
        if (success) {
          res.json({ status: 'started' });
        } else {
          res.status(409).json({ error: 'Already running' });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    this.app.post('/conversation/stop', async (_req: Request, res: Response) => {
      try {
        await this.callManager.hangUp();
        res.json({ status: 'stopped' });
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
