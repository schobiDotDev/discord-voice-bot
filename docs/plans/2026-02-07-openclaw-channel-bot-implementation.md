# OpenClaw Channel Bot — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the Discord Voice Bot's bot mode to OpenClaw as a channel, so transcriptions go to OpenClaw via HTTP and agent responses come back via `/speak`, while keeping a persistent text-channel log.

**Architecture:** Two independent processes (Bot + OpenClaw Plugin) connected via HTTP. Bot sends transcriptions to OpenClaw bridge and logs them to a Discord text channel. OpenClaw routes to agent session, agent responds via `sendText()` which calls the Bot's `/speak` endpoint. Bot plays TTS and logs the response.

**Tech Stack:** TypeScript, discord.js, Express, node:http fetch, Zod

---

### Task 1: Add OpenClaw bridge config

**Files:**
- Modify: `src/config.ts`

**Step 1: Add openclawBridge section to config schema**

In `src/config.ts`, add a new optional config section after `textBridge`:

```typescript
// OpenClaw bridge (optional — when set, transcriptions go to OpenClaw instead of waiting for responder bot)
openclawBridge: z.object({
  url: z.string().url().optional(),
}).default({}),
```

And in `parseConfig()` rawConfig, add:

```typescript
openclawBridge: {
  url: process.env.OPENCLAW_BRIDGE_URL || undefined,
},
```

**Step 2: Verify config parses**

Run: `npx tsx src/config.ts` (or `npm run typecheck`)
Expected: No errors. Config still works without `OPENCLAW_BRIDGE_URL` set.

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add OPENCLAW_BRIDGE_URL config option"
```

---

### Task 2: Add log-only method to TextBridgeService

**Files:**
- Modify: `src/services/text-bridge.ts`

The existing `postAndWaitForResponse()` posts a transcription AND waits for a response. We need a fire-and-forget `log()` method that just posts to the text channel without waiting.

**Step 1: Add `log` method**

Add to `TextBridgeService` class:

```typescript
/**
 * Log a message to the text channel (fire-and-forget, no response waiting)
 */
async log(message: string): Promise<void> {
  if (!this.textChannel) {
    logger.warn('Text bridge not initialized, cannot log');
    return;
  }

  try {
    await this.textChannel.send(message);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to log to text channel: ${msg}`);
  }
}
```

**Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/text-bridge.ts
git commit -m "feat: add fire-and-forget log method to TextBridgeService"
```

---

### Task 3: Create OpenClawBridgeService

**Files:**
- Create: `src/services/openclaw-bridge.ts`
- Modify: `src/services/index.ts`

**Step 1: Create the bridge service**

Create `src/services/openclaw-bridge.ts`:

```typescript
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
```

**Step 2: Export from index**

Add to `src/services/index.ts`:

```typescript
export { OpenClawBridgeService } from './openclaw-bridge.js';
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/services/openclaw-bridge.ts src/services/index.ts
git commit -m "feat: add OpenClawBridgeService for sending transcriptions"
```

---

### Task 4: Create BotApiServer for bot mode

**Files:**
- Create: `src/services/bot-api-server.ts`
- Modify: `src/services/index.ts`

The existing `ApiServer` is coupled to `CallManager` (browser mode). Bot mode needs a lightweight server that accepts `/speak` and routes to the voice player.

**Step 1: Create BotApiServer**

Create `src/services/bot-api-server.ts`:

```typescript
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
```

**Step 2: Export from index**

Add to `src/services/index.ts`:

```typescript
export { BotApiServer } from './bot-api-server.js';
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/services/bot-api-server.ts src/services/index.ts
git commit -m "feat: add BotApiServer for receiving /speak in bot mode"
```

---

### Task 5: Modify VoiceAssistant for OpenClaw bridge mode

**Files:**
- Modify: `src/services/voice-assistant.ts`

This is the core change. When an `OpenClawBridgeService` is provided, the assistant sends transcriptions to OpenClaw instead of waiting for a text bridge response. It still logs to the text channel.

**Step 1: Add OpenClaw bridge support to constructor and handleRecording**

Modify the constructor to accept an optional `OpenClawBridgeService`:

```typescript
import { OpenClawBridgeService } from './openclaw-bridge.js';
import type { TextBridgeService } from './text-bridge.js';

export class VoiceAssistant {
  // ... existing fields ...
  private openclawBridge: OpenClawBridgeService | null;
  private textBridge: TextBridgeService | null;

  constructor(
    sttProvider: STTProvider,
    ttsProvider: TTSProvider,
    conversationService: ConversationService,
    wakeWordProvider: WakeWordProvider | null = null,
    openclawBridge: OpenClawBridgeService | null = null,
    textBridge: TextBridgeService | null = null
  ) {
    // ... existing init ...
    this.openclawBridge = openclawBridge;
    this.textBridge = textBridge;
  }
```

**Step 2: Modify handleRecording to branch on bridge mode**

Replace the section after trigger word handling (lines ~288-310) in `handleRecording()`:

```typescript
// Mark as processing
guildState.isProcessing = true;

// Play confirmation sound
await this.playConfirmation(guildState);

if (this.openclawBridge) {
  // ── OpenClaw Bridge Mode ──
  // Send to OpenClaw (fire-and-forget, response comes via /speak)
  const channelId = guildState.channel.id;
  const username = this.conversationService.getUsername(userId);

  this.openclawBridge.sendTranscription({
    text: cleanedText,
    userId,
    userName: username,
    channelId,
    guildId: guildId!,
  }).catch(() => {});

  // Log to text channel (fire-and-forget)
  if (this.textBridge) {
    this.textBridge.log(
      `🎤 **${username}:** ${cleanedText}`
    ).catch(() => {});
  }

  // Not waiting for response — it comes async via /speak
  guildState.isProcessing = false;
  voiceRecorder.restartRecording(guildState.connection, userId);
} else {
  // ── Original TextBridge Mode ──
  const response = await this.conversationService.chat(userId, cleanedText, durationSeconds);

  if (!response) {
    guildState.isProcessing = false;
    voiceRecorder.restartRecording(guildState.connection, userId);
    return;
  }

  if (guildState.mode !== 'silent') {
    await voicePlayer.playSound('result');
  }

  await voicePlayer.speak(response);

  guildState.isProcessing = false;
  voiceRecorder.restartRecording(guildState.connection, userId);
}
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/services/voice-assistant.ts
git commit -m "feat: add OpenClaw bridge mode to VoiceAssistant"
```

---

### Task 6: Wire everything up in Bot

**Files:**
- Modify: `src/bot.ts`

**Step 1: Conditionally create OpenClaw bridge and API server**

Add imports and modify the `Bot` constructor and `start()`/`stop()`:

```typescript
import { OpenClawBridgeService, BotApiServer } from './services/index.js';

export class Bot {
  // ... existing fields ...
  private openclawBridge: OpenClawBridgeService | null = null;
  private botApiServer: BotApiServer | null = null;

  constructor() {
    // ... existing client/provider setup ...

    // Initialize OpenClaw bridge if configured
    const bridgeUrl = config.openclawBridge.url;
    if (bridgeUrl) {
      this.openclawBridge = new OpenClawBridgeService(bridgeUrl);
    }

    // Initialize text bridge
    this.textBridge = new TextBridgeService(this.client);

    // Initialize services
    this.conversationService = new ConversationService(this.textBridge);
    this.voiceAssistant = new VoiceAssistant(
      sttProvider,
      ttsProvider,
      this.conversationService,
      this.wakeWordProvider,
      this.openclawBridge,
      this.textBridge
    );

    // API server for OpenClaw (accepts /speak)
    if (this.openclawBridge) {
      this.botApiServer = new BotApiServer(config.api.port, this.textBridge);
    }

    this.setupEventHandlers();
  }

  async start(): Promise<void> {
    // ... existing startup ...

    // Start API server if OpenClaw bridge is configured
    if (this.botApiServer) {
      await this.botApiServer.start();
    }

    // Login to Discord
    logger.info('Logging in to Discord...');
    await this.client.login(config.discord.token);
  }

  async stop(): Promise<void> {
    // ... existing shutdown ...

    // Stop API server
    if (this.botApiServer) {
      await this.botApiServer.stop();
    }

    // ... rest of shutdown ...
  }
}
```

**Step 2: Make textBridge config optional when using OpenClaw bridge**

In `src/config.ts`, the `textBridge` section currently requires `channelId` and `responderBotId`. When using the OpenClaw bridge, `responderBotId` is no longer needed. But `channelId` is still needed for logging.

Update the textBridge schema to make `responderBotId` optional:

```typescript
textBridge: z.object({
  channelId: z.string().optional(),
  responderBotId: z.string().optional(),
  responseTimeout: z.number().int().positive().default(30000),
}),
```

And update `parseConfig()`:

```typescript
textBridge: {
  channelId: process.env.TEXT_CHANNEL_ID || undefined,
  responderBotId: process.env.RESPONDER_BOT_ID || undefined,
  responseTimeout: parseInt(process.env.RESPONSE_TIMEOUT ?? '30000', 10),
},
```

Guard the `TextBridgeService.initialize()` to handle missing `responderBotId`:

```typescript
// In TextBridgeService.initialize():
if (!channelId) {
  logger.info('TEXT_CHANNEL_ID not set, text bridge disabled');
  return;
}
```

And guard `setupMessageListener` to only listen when responderBotId is set:

```typescript
private setupMessageListener(): void {
  if (!config.textBridge.responderBotId) return; // No responder to listen for
  // ... existing listener code ...
}
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/bot.ts src/config.ts src/services/text-bridge.ts
git commit -m "feat: wire OpenClaw bridge and BotApiServer into Bot startup"
```

---

### Task 7: Update OpenClaw Plugin — Inbound HTTP Server

**Files:**
- Modify: `openclaw-extension/index.ts`
- Modify: `openclaw-extension/openclaw.plugin.json`

**Step 1: Add HTTP server for inbound transcriptions**

This is the OpenClaw-side change. The plugin needs to accept POST `/inbound` from the voice bot and route it into the OpenClaw agent session.

Update `openclaw-extension/index.ts` to start an HTTP server:

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

let api: OpenClawPluginApi;

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const plugin = {
  id: "discord-voice",
  name: "Discord Voice Channel",
  description: "Discord voice channel integration for OpenClaw — bidirectional voice bridge",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      voiceBotUrl: {
        type: "string" as const,
        default: "http://localhost:8788",
      },
      inboundPort: {
        type: "number" as const,
        default: 8790,
      },
      ownerId: {
        type: "string" as const,
      },
    },
  },
  register(pluginApi: OpenClawPluginApi) {
    api = pluginApi;

    const config = pluginApi.config?.plugins?.entries?.["discord-voice"]?.config ?? {};
    const voiceBotUrl = (config as any).voiceBotUrl ?? "http://localhost:8788";
    const inboundPort = (config as any).inboundPort ?? 8790;

    // Register channel (outbound: agent -> voice bot)
    pluginApi.registerChannel({
      plugin: {
        id: "discord-voice",
        meta: {
          id: "discord-voice",
          label: "Discord Voice",
          selectionLabel: "Discord Voice Channel",
          docsPath: "/channels/discord-voice",
          blurb: "Discord voice channel integration with STT/TTS.",
          aliases: ["voice", "dv"],
        },
        capabilities: {
          chatTypes: ["group"] as const,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: (_cfg: any, accountId?: string) => ({
            accountId: accountId ?? "default",
            enabled: true,
          }),
        },
        outbound: {
          deliveryMode: "direct" as const,
          sendText: async (opts: { text: string }) => {
            const cleanText = opts.text
              .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
              .replace(/[*_~`#]/g, "")
              .replace(/\n{3,}/g, "\n\n")
              .replace(/NO_REPLY/g, "")
              .trim();

            if (!cleanText) return { ok: true };

            try {
              const res = await fetch(`${voiceBotUrl}/speak`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: cleanText }),
              });
              return { ok: res.ok };
            } catch (err) {
              console.error(`[discord-voice] Speak failed: ${err}`);
              return { ok: false };
            }
          },
        },
      },
    });

    // Start inbound HTTP server (voice bot -> OpenClaw)
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/inbound') {
        try {
          const body = await parseBody(req);
          const { text, userId, userName, channelId } = body;

          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'text is required' }));
            return;
          }

          // Format with username for agent context
          const formatted = userName ? `${userName}: ${text}` : text;

          // TODO: Route to OpenClaw agent session
          // This depends on the OpenClaw plugin API for session routing.
          // For now, use hooks/wake as the integration point.
          // The exact API call will need to match OpenClaw's plugin SDK.
          console.log(`[discord-voice] Inbound from ${userName} (${userId}): ${text}`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error(`[discord-voice] Inbound error: ${err}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal error' }));
        }
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(inboundPort, () => {
      console.log(`[discord-voice] Inbound server listening on port ${inboundPort}`);
    });

    console.log(`[discord-voice] Plugin registered. Voice Bot: ${voiceBotUrl}`);
  },
};

export default plugin;
```

**Step 2: Update plugin manifest**

Update `openclaw-extension/openclaw.plugin.json` to include the new config:

```json
{
  "id": "discord-voice",
  "name": "Discord Voice Channel",
  "version": "0.2.0",
  "description": "Discord voice channel integration for OpenClaw — bidirectional voice bridge",
  "entry": "./index.ts",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "voiceBotUrl": {
        "type": "string",
        "default": "http://localhost:8788",
        "description": "Voice bot API server URL"
      },
      "inboundPort": {
        "type": "number",
        "default": 8790,
        "description": "Port for inbound transcription HTTP server"
      },
      "ownerId": {
        "type": "string",
        "description": "Discord user ID of the owner"
      }
    }
  },
  "uiHints": {
    "voiceBotUrl": { "label": "Voice Bot API URL", "placeholder": "http://localhost:8788" },
    "inboundPort": { "label": "Inbound Port", "placeholder": "8790" },
    "ownerId": { "label": "Owner Discord User ID" }
  }
}
```

**Step 3: Commit**

```bash
git add openclaw-extension/index.ts openclaw-extension/openclaw.plugin.json
git commit -m "feat: add inbound HTTP server to OpenClaw plugin"
```

---

### Task 8: Integration test — manual end-to-end

**No files to create — manual verification steps.**

**Step 1: Start bot with OpenClaw bridge**

Create/update `.env`:
```env
MODE=bot
OPENCLAW_BRIDGE_URL=http://localhost:8790/inbound
API_PORT=8788
TEXT_CHANNEL_ID=<your_channel_id>
# RESPONDER_BOT_ID not needed in bridge mode
```

Run: `npm run dev`
Expected: Bot logs in, API server starts on 8788.

**Step 2: Test /speak endpoint**

Run: `curl -X POST http://localhost:8788/speak -H "Content-Type: application/json" -d '{"text": "Hallo, das ist ein Test"}'`
Expected: Bot speaks TTS in the active voice channel (must have done `/join` first).

**Step 3: Test /health**

Run: `curl http://localhost:8788/health`
Expected: `{"status":"ok","mode":"bot"}`

**Step 4: Test transcription flow**

1. Join a voice channel with `/join free`
2. Speak something
3. Check logs for: `Transcription sent to OpenClaw bridge`
4. Check text channel for: `🎤 **YourName:** what you said`

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test adjustments"
```

---

## Task Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add OPENCLAW_BRIDGE_URL config | `src/config.ts` |
| 2 | Add log-only method to TextBridgeService | `src/services/text-bridge.ts` |
| 3 | Create OpenClawBridgeService | `src/services/openclaw-bridge.ts`, `src/services/index.ts` |
| 4 | Create BotApiServer | `src/services/bot-api-server.ts`, `src/services/index.ts` |
| 5 | Modify VoiceAssistant for bridge mode | `src/services/voice-assistant.ts` |
| 6 | Wire up in Bot + make textBridge optional | `src/bot.ts`, `src/config.ts`, `src/services/text-bridge.ts` |
| 7 | Update OpenClaw plugin with inbound server | `openclaw-extension/index.ts`, `openclaw-extension/openclaw.plugin.json` |
| 8 | Manual integration test | — |

## Notes

- The OpenClaw plugin's session routing (Task 7 TODO) depends on the exact OpenClaw plugin SDK API for sending messages into sessions. The `hooks/wake` endpoint is the known integration point, but the plugin SDK may offer a more direct method. This should be investigated during implementation with access to the OpenClaw source.
- Tasks 1-6 are on the bot side and can be implemented and tested independently.
- Task 7 is on the OpenClaw side and needs OpenClaw running to test.
