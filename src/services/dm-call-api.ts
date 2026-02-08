import express, { type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { logger } from '../utils/logger.js';
import type { DmCallService } from './dm-call-service-v2.js';

/**
 * HTTP API for the DM-Call service.
 * Thin layer — delegates all logic to DmCallService.
 */
export class DmCallApi {
  private app: express.Application;
  private server: Server | null = null;
  private port: number;
  private callService: DmCallService;

  constructor(port: number, callService: DmCallService) {
    this.port = port;
    this.callService = callService;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(this.app);
      this.server.listen(this.port, () => {
        logger.info(`DM-Call API listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('DM-Call API stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private setupRoutes(): void {
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', service: 'dm-call' });
    });

    this.app.post('/call', (req: Request, res: Response) => {
      const { userId, dmChannelId, message, callbackUrl, channelId, maxTurns, agentResponseTimeout, keepRecordings } = req.body as {
        userId?: string;
        dmChannelId?: string;
        message?: string;
        callbackUrl?: string;
        channelId?: string;
        maxTurns?: number;
        agentResponseTimeout?: number;
        keepRecordings?: boolean;
      };

      if (!userId || !dmChannelId || !message || !callbackUrl) {
        res.status(400).json({ error: 'userId, dmChannelId, message, and callbackUrl are required' });
        return;
      }

      if (this.callService.busy) {
        res.status(409).json({
          error: 'A call is already in progress',
          activeCallId: this.callService.currentCall?.callId,
        });
        return;
      }

      try {
        const callId = this.callService.startCall({
          userId, dmChannelId, message, callbackUrl, channelId,
          maxTurns, agentResponseTimeout, keepRecordings,
        });
        res.status(202).json({ callId, status: 'calling' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`POST /call error: ${msg}`);
        res.status(500).json({ error: msg });
      }
    });

    this.app.get('/call/:callId', (req: Request<{ callId: string }>, res: Response) => {
      const { callId } = req.params;

      // Check active call
      const active = this.callService.currentCall;
      if (active?.callId === callId) {
        res.json({
          callId,
          status: active.status,
          userId: active.userId,
          turnCount: active.turnCount,
          startedAt: active.startedAt.toISOString(),
        });
        return;
      }

      // Check completed calls
      const result = this.callService.getCallResult(callId);
      if (result) {
        res.json(result);
        return;
      }

      res.status(404).json({ error: 'Call not found' });
    });

    this.app.post('/call/:callId/respond', (req: Request<{ callId: string }>, res: Response) => {
      const { callId } = req.params;
      const { text, hangup } = req.body as { text?: string; hangup?: boolean };

      if (!text && !hangup) {
        res.status(400).json({ error: 'text or hangup is required' });
        return;
      }

      const accepted = this.callService.respondToCall(callId, { text, hangup });
      if (accepted) {
        res.json({ ok: true });
      } else {
        res.status(409).json({ error: 'Call not waiting for response' });
      }
    });

    this.app.post('/call/:callId/hangup', (req: Request<{ callId: string }>, res: Response) => {
      const { callId } = req.params;

      const accepted = this.callService.hangupCall(callId);
      if (accepted) {
        res.json({ ok: true });
      } else {
        res.status(404).json({ error: 'Call not found or already ended' });
      }
    });
  }
}
