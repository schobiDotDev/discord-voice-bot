import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

/**
 * Controls a Discord browser session via Chrome DevTools Protocol.
 * Handles navigation, call initiation, mute control, and hangup.
 *
 * Uses a persistent WebSocket connection for efficient CDP communication.
 */
export class DiscordBrowser {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private cdpUrl: string;

  constructor(cdpUrl?: string) {
    this.cdpUrl = cdpUrl ?? config.dmCall.cdpUrl;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the Discord browser tab via CDP.
   * Finds the Discord page target and opens a persistent WebSocket.
   */
  async connect(): Promise<void> {
    // Extract host:port from ws:// URL for HTTP endpoint
    const wsUrl = new URL(this.cdpUrl);
    const httpBase = `http://${wsUrl.hostname}:${wsUrl.port}`;

    const res = await fetch(`${httpBase}/json/list`);
    const targets = (await res.json()) as Array<{ id: string; url: string; type: string }>;
    const discord = targets.find(t => t.url?.includes('discord.com') && t.type === 'page');

    if (!discord) {
      throw new Error('No Discord tab found in CDP browser');
    }

    const targetWsUrl = `ws://${wsUrl.hostname}:${wsUrl.port}/devtools/page/${discord.id}`;
    logger.info(`CDP connecting to ${targetWsUrl}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(targetWsUrl);
      ws.on('open', () => {
        this.ws = ws;
        this.msgId = 0;
        logger.info('CDP connected');
        resolve();
      });
      ws.on('error', (err) => {
        reject(new Error(`CDP connection failed: ${err.message}`));
      });
      ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  /** Disconnect CDP WebSocket */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Navigate to a user's DM channel.
   * @param dmChannelId Discord DM channel ID (from the URL, not the user ID)
   */
  async navigateToDM(dmChannelId: string): Promise<void> {
    const targetPath = `channels/@me/${dmChannelId}`;
    const currentUrl = await this.eval('window.location.href') as string;
    if (currentUrl?.includes(targetPath)) {
      logger.debug('Already on correct DM page');
      return;
    }

    await this.eval(`window.location.href = 'https://discord.com/${targetPath}'`);
    await sleep(2500);
    logger.info(`Navigated to DM channel ${dmChannelId}`);
  }

  /** Click "Start Voice Call" button */
  async startCall(): Promise<void> {
    await this.ensureUnmuted();
    await sleep(300);

    const result = await this.eval(`
      (() => {
        if (document.querySelector('[aria-label="Disconnect"]')) return 'already-connected';
        const startBtn = document.querySelector('[aria-label="Start Voice Call"]');
        if (startBtn) { startBtn.click(); return 'started'; }
        const joinBtn = document.querySelector('[aria-label="Join Call"]')
          || document.querySelector('[aria-label="Join Voice Call"]');
        if (joinBtn) { joinBtn.click(); return 'joined'; }
        return 'no-button';
      })()
    `) as string;

    logger.info(`Call action: ${result}`);
    if (result === 'no-button') {
      throw new Error('No call button found on DM page');
    }
  }

  /**
   * Wait for call to connect (user answers).
   * Returns false on timeout (no answer).
   */
  async waitForConnection(timeoutMs?: number): Promise<boolean> {
    const timeout = timeoutMs ?? config.dmCall.connectTimeout;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const status = await this.eval(`
        (() => {
          if (document.querySelector('[aria-label="Disconnect"]')) return 'connected';
          const text = document.body?.innerText ?? '';
          if (text.includes('Voice Connected')) return 'connected';
          if (text.includes('Calling') || text.includes('Ringing')) return 'ringing';
          if (document.querySelector('[aria-label="Join Call"]')) return 'needs-join';
          return 'waiting';
        })()
      `) as string;

      if (status === 'connected') {
        logger.info('Call connected');
        return true;
      }

      if (status === 'needs-join') {
        logger.info('Joining existing call...');
        await this.eval(`document.querySelector('[aria-label="Join Call"]')?.click()`);
        await sleep(2000);
      }

      logger.debug(`Call status: ${status}`);
      await sleep(1500);
    }

    logger.warn('Call connection timed out');
    return false;
  }

  /** Ensure microphone is unmuted */
  async ensureUnmuted(): Promise<void> {
    const result = await this.eval(`
      (() => {
        const switches = document.querySelectorAll('button[role="switch"]');
        for (const sw of switches) {
          const label = sw.textContent || sw.getAttribute('aria-label') || '';
          if (label.includes('Mute') || label.includes('Unmute')) {
            if (sw.getAttribute('aria-checked') === 'true') {
              sw.click();
              return 'unmuted';
            }
            return 'already-unmuted';
          }
        }
        return 'no-switch-found';
      })()
    `) as string;

    logger.debug(`Mute check: ${result}`);
  }

  /** Hang up the call */
  async hangup(): Promise<void> {
    const result = await this.eval(`
      (() => {
        const btn = document.querySelector('[aria-label="Disconnect"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);

    if (result) {
      logger.info('Call disconnected');
    } else {
      logger.debug('No disconnect button found (already disconnected?)');
    }
  }

  /**
   * Evaluate a JavaScript expression in the browser via CDP.
   * Uses the persistent WebSocket connection.
   */
  async eval(expression: string, timeout = 15000): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected');
    }

    const id = ++this.msgId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws?.off('message', handler);
        reject(new Error('CDP eval timeout'));
      }, timeout);

      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          this.ws?.off('message', handler);
          if (msg.result?.exceptionDetails) {
            reject(new Error(
              msg.result.exceptionDetails.exception?.description ?? 'CDP eval error'
            ));
          } else {
            resolve(msg.result?.result?.value);
          }
        }
      };

      this.ws!.on('message', handler);
      this.ws!.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
