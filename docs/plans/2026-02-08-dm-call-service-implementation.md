# DM-Call Service — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone DM-Call Service that lets OpenClaw call Discord users via a real Discord account (CDP-controlled browser), speak a greeting, record the user's response with VAD-based silence detection, transcribe it, and send the result back via async callback.

**Architecture:** Standalone Express server (port 8792) communicating with a Chromium browser via CDP and using BlackHole virtual audio for routing. Async API with callback — `POST /call` returns `202` immediately, result is delivered to `callbackUrl` after call ends.

**Tech Stack:** TypeScript, Express, WebSocket (CDP), ffmpeg (recording), existing STT/TTS/VAD providers

**Reference:** Existing prototypes in `scripts/dm-call-mvp.ts` and `src/services/dm-call-service.ts` contain proven CDP and audio patterns to reuse.

---

### Task 1: Extend config with DM-Call settings

**Files:**
- Modify: `src/config.ts`

**Step 1: Add dmCall section to config schema**

Add after the `openclawBridge` section:

```typescript
dmCall: z.object({
  port: z.number().int().positive().default(8792),
  cdpUrl: z.string().default('ws://localhost:9222'),
  blackholeInput: z.string().default('BlackHole 2ch'),
  blackholeOutput: z.string().default('BlackHole 16ch'),
  systemAudioDevice: z.string().default('MacBook Air-Lautsprecher'),
  timeout: z.number().int().positive().default(60),
  silenceTimeout: z.number().positive().default(1.5),
  connectTimeout: z.number().int().positive().default(20000),
}).default({}),
```

And in `parseConfig()` rawConfig:

```typescript
dmCall: {
  port: parseInt(process.env.DM_CALL_PORT ?? '8792', 10),
  cdpUrl: process.env.CDP_URL || 'ws://localhost:9222',
  blackholeInput: process.env.BLACKHOLE_INPUT || 'BlackHole 2ch',
  blackholeOutput: process.env.BLACKHOLE_OUTPUT || 'BlackHole 16ch',
  systemAudioDevice: process.env.AUDIO_SYSTEM_DEVICE || 'MacBook Air-Lautsprecher',
  timeout: parseInt(process.env.DM_CALL_TIMEOUT ?? '60', 10),
  silenceTimeout: parseFloat(process.env.DM_CALL_SILENCE ?? '1.5'),
  connectTimeout: parseInt(process.env.DM_CALL_CONNECT_TIMEOUT ?? '20000', 10),
},
```

**Step 2: Verify typecheck**

Run: `npm run typecheck`

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add DM-Call service config options"
```

---

### Task 2: Create DiscordBrowser — CDP control layer

**Files:**
- Create: `src/services/discord-browser.ts`

This wraps all CDP interaction with the Discord browser. Extracted from `scripts/dm-call-mvp.ts` patterns but cleaned up as a proper class.

**Step 1: Create DiscordBrowser class**

```typescript
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

/**
 * Controls a Discord browser session via Chrome DevTools Protocol.
 * Handles navigation, call initiation, mute control, and hangup.
 */
export class DiscordBrowser {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private cdpUrl: string;

  constructor(cdpUrl?: string) {
    this.cdpUrl = cdpUrl ?? config.dmCall.cdpUrl;
  }

  /** Connect to the Discord browser tab via CDP */
  async connect(): Promise<void> {
    // 1. Get target list from CDP HTTP endpoint
    //    Extract host:port from ws:// URL
    // 2. Find Discord page target
    // 3. Open persistent WebSocket to that target
  }

  /** Disconnect CDP WebSocket */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Navigate to a DM channel */
  async navigateToDM(userId: string): Promise<void> {
    // Navigate to discord.com/channels/@me
    // Find or open DM with userId
    // Wait for page to load
  }

  /** Click "Start Voice Call" button */
  async startCall(): Promise<void> {
    // Find and click the call button
    // Handle "Start Voice Call", "Join Call", "Join Voice Call" variants
  }

  /** Wait for call to connect (user answers) */
  async waitForConnection(timeoutMs?: number): Promise<boolean> {
    // Poll DOM for "Disconnect" button (= connected)
    // Return false on timeout (no answer)
  }

  /** Ensure microphone is unmuted */
  async ensureUnmuted(): Promise<void> {
    // Check mute switch state, click if muted
  }

  /** Hang up the call */
  async hangup(): Promise<void> {
    // Click "Disconnect" button
  }

  /** Evaluate JS expression in the browser */
  async eval(expression: string, timeout?: number): Promise<unknown> {
    // Send Runtime.evaluate via CDP WebSocket
    // Return result value
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
```

Implementation: Port the CDP helpers from `scripts/dm-call-mvp.ts` lines 57-149 into this class. Key patterns:
- `getTargetId()` → use HTTP endpoint to list targets, find discord.com page
- `cdpEval()` → `Runtime.evaluate` with `awaitPromise: true, returnByValue: true`
- `clickStartVoiceCall()` → query `[aria-label="Start Voice Call"]`
- `waitForCallConnected()` → poll for `[aria-label="Disconnect"]`
- `hangUp()` → query and click `[aria-label="Disconnect"]`
- `ensureUnmuted()` → from `src/services/dm-call-service.ts` lines 123-141

Use a persistent WebSocket connection (like `dm-call-service.ts` lines 62-98) instead of opening a new one per eval (like `dm-call-mvp.ts`).

**Step 2: Verify typecheck**

Run: `npm run typecheck`

**Step 3: Commit**

```bash
git add src/services/discord-browser.ts
git commit -m "feat: add DiscordBrowser CDP control layer for DM calls"
```

---

### Task 3: Create AudioBridge — BlackHole recording & playback

**Files:**
- Create: `src/services/audio-bridge.ts`

Handles audio routing via BlackHole: TTS playback to Discord mic input, and recording Discord audio output.

**Step 1: Create AudioBridge class**

```typescript
import { execSync, spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

/**
 * Audio routing via BlackHole virtual audio devices.
 * - Playback: System output → BlackHole 2ch → Discord mic input
 * - Recording: Discord audio output → BlackHole 16ch → ffmpeg
 */
export class AudioBridge {
  private blackholeInput: string;   // For recording (Discord output)
  private blackholeOutput: string;  // For playback (Discord input)
  private systemDevice: string;
  private recordingsDir: string;

  constructor() {
    this.blackholeInput = config.dmCall.blackholeOutput;   // BlackHole 16ch
    this.blackholeOutput = config.dmCall.blackholeInput;   // BlackHole 2ch
    this.systemDevice = config.dmCall.systemAudioDevice;
    this.recordingsDir = join(process.cwd(), 'recordings');
    mkdirSync(this.recordingsDir, { recursive: true });
  }

  /**
   * Play a WAV/audio buffer to Discord via BlackHole.
   * Switches system output → BlackHole 2ch → plays with afplay → switches back.
   */
  async playToDiscord(audioBuffer: Buffer): Promise<void> {
    // Write buffer to temp file
    // Switch audio output to BlackHole 2ch
    // afplay the file
    // Switch back to system device
    // Cleanup temp file
  }

  /**
   * Start recording from BlackHole 16ch (Discord's audio output).
   * Returns the ffmpeg process and output file path.
   */
  startRecording(): { process: ChildProcess; filePath: string } {
    // Find BlackHole 16ch device index via ffmpeg -list_devices
    // Start ffmpeg recording: -f avfoundation -i :deviceIdx -ar 16000 -ac 1
    // Return process handle for later stop
  }

  /**
   * Stop a recording and return the file path.
   */
  async stopRecording(proc: ChildProcess): Promise<string> {
    // Send SIGTERM to ffmpeg
    // Wait for process to exit
    // Return the output file path
  }

  /** Restore system audio to default device */
  restoreAudio(): void {
    // SwitchAudioSource -s "MacBook Air-Lautsprecher" -t output
  }

  /** Clean up a recording file */
  cleanup(filePath: string): void {
    try { unlinkSync(filePath); } catch {}
  }
}
```

Implementation: Port from `scripts/dm-call-mvp.ts`:
- `playToDiscord()` → lines 175-200 (SwitchAudioSource + afplay)
- `startRecording()` / `stopRecording()` → lines 203-247 (ffmpeg avfoundation recording)
- `getInputDeviceIndex()` → lines 203-218 (ffmpeg device listing)

**Step 2: Verify typecheck**

Run: `npm run typecheck`

**Step 3: Commit**

```bash
git add src/services/audio-bridge.ts
git commit -m "feat: add AudioBridge for BlackHole audio routing"
```

---

### Task 4: Create DmCallService — Call orchestration

**Files:**
- Create: `src/services/dm-call-service-v2.ts` (v2 to avoid conflict with existing prototype)

This is the core orchestration layer. Manages call lifecycle, coordinates DiscordBrowser + AudioBridge + STT/TTS/VAD.

**Step 1: Create DmCallService class**

```typescript
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { DiscordBrowser } from './discord-browser.js';
import { AudioBridge } from './audio-bridge.js';
import { createSTTProvider } from '../providers/stt/index.js';
import { createTTSProvider } from '../providers/tts/index.js';
import { createWakeWordProvider } from '../providers/wakeword/index.js';

export interface CallRequest {
  userId: string;
  message: string;
  callbackUrl: string;
  channelId?: string;
}

export interface CallResult {
  callId: string;
  status: 'completed' | 'no_answer' | 'failed';
  transcription?: string;
  duration?: number;
  userId: string;
  channel: string;
  channelId: string;
  error?: string;
}

export interface ActiveCall {
  callId: string;
  userId: string;
  callbackUrl: string;
  channelId: string;
  status: 'connecting' | 'greeting' | 'recording' | 'transcribing';
  startedAt: Date;
}

export class DmCallService {
  private activeCall: ActiveCall | null = null;
  private browser: DiscordBrowser;
  private audio: AudioBridge;
  private sttProvider: ReturnType<typeof createSTTProvider>;
  private ttsProvider: ReturnType<typeof createTTSProvider>;
  private vadProvider: ReturnType<typeof createWakeWordProvider>;
  private completedCalls: Map<string, CallResult> = new Map();

  constructor() {
    this.browser = new DiscordBrowser();
    this.audio = new AudioBridge();
    this.sttProvider = createSTTProvider();
    this.ttsProvider = createTTSProvider();
    this.vadProvider = createWakeWordProvider();
  }

  async initialize(): Promise<void> {
    if (this.vadProvider) {
      await this.vadProvider.initialize();
    }
  }

  get busy(): boolean { return this.activeCall !== null; }
  get currentCall(): ActiveCall | null { return this.activeCall; }

  getCallResult(callId: string): CallResult | undefined {
    return this.completedCalls.get(callId);
  }

  /**
   * Start a DM call. Returns callId immediately.
   * Call runs in background, result delivered to callbackUrl.
   */
  async startCall(request: CallRequest): Promise<string> {
    if (this.activeCall) {
      throw new Error('A call is already in progress');
    }

    const callId = `call_${randomUUID().substring(0, 8)}`;
    this.activeCall = {
      callId,
      userId: request.userId,
      callbackUrl: request.callbackUrl,
      channelId: request.channelId ?? 'dm-call',
      status: 'connecting',
      startedAt: new Date(),
    };

    // Run call flow in background
    this.executeCall(callId, request).catch((error) => {
      logger.error(`Call ${callId} failed: ${error.message}`);
    });

    return callId;
  }

  private async executeCall(callId: string, request: CallRequest): Promise<void> {
    const result: CallResult = {
      callId,
      status: 'failed',
      userId: request.userId,
      channel: 'discord-voice',
      channelId: request.channelId ?? 'dm-call',
    };

    try {
      // Phase 1: Connect
      this.updateStatus(callId, 'connecting');
      await this.browser.connect();
      await this.browser.navigateToDM(request.userId);
      await this.browser.startCall();

      const connected = await this.browser.waitForConnection(config.dmCall.connectTimeout);
      if (!connected) {
        result.status = 'no_answer';
        await this.sendCallback(request.callbackUrl, result);
        return;
      }

      await this.browser.ensureUnmuted();
      await sleep(1500); // Audio stabilization

      // Phase 2: Greeting
      this.updateStatus(callId, 'greeting');
      const ttsAudio = await this.ttsProvider.synthesize(request.message);
      await this.audio.playToDiscord(ttsAudio);
      await sleep(500); // Brief pause after speaking

      // Phase 3: Record with VAD
      this.updateStatus(callId, 'recording');
      const audioFile = await this.recordWithVAD();

      // Phase 4: Hang up & transcribe
      await this.browser.hangup();
      this.audio.restoreAudio();

      this.updateStatus(callId, 'transcribing');
      const transcription = await this.sttProvider.transcribe(audioFile);
      this.audio.cleanup(audioFile);

      result.status = 'completed';
      result.transcription = transcription;
      result.duration = (Date.now() - this.activeCall!.startedAt.getTime()) / 1000;

      await this.sendCallback(request.callbackUrl, result);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Call ${callId} error: ${msg}`);
      result.status = 'failed';
      result.error = msg;

      // Cleanup
      try { await this.browser.hangup(); } catch {}
      this.audio.restoreAudio();
      this.browser.disconnect();

      await this.sendCallback(request.callbackUrl, result);
    } finally {
      this.completedCalls.set(callId, result);
      this.activeCall = null;
      this.browser.disconnect();
    }
  }

  /**
   * Record audio with VAD-based silence detection.
   * Starts recording, waits for speech, then waits for silence.
   */
  private async recordWithVAD(): Promise<string> {
    // Start ffmpeg recording
    // Feed audio chunks to VAD provider
    // When speech detected: mark as "user speaking"
    // When speech ends + silenceTimeout: stop recording
    // Safety timeout: config.dmCall.timeout seconds max
    // Return path to recorded audio file

    // TODO: Implementation detail — the VAD provider in this codebase
    // works with the voice recorder's audio streams. For DM-call,
    // we need to apply similar logic to ffmpeg's output.
    // Simplest approach: record for a fixed duration with ffmpeg,
    // then post-process for silence trimming. Or use the VAD
    // on the raw PCM stream from ffmpeg stdout.

    // MVP: Use ffmpeg with silencedetect filter as a simpler alternative:
    // ffmpeg -f avfoundation -i :deviceIdx -af silencedetect=n=-30dB:d=1.5 -t 60 output.wav
    // Parse stderr for silence_start/silence_end events
  }

  private updateStatus(callId: string, status: ActiveCall['status']): void {
    if (this.activeCall?.callId === callId) {
      this.activeCall.status = status;
    }
  }

  private async sendCallback(url: string, result: CallResult): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
      if (!res.ok) {
        logger.error(`Callback failed: ${res.status} ${res.statusText}`);
        // Retry once
        await sleep(2000);
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        }).catch(() => {});
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Callback request failed: ${msg}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.activeCall) {
      try { await this.browser.hangup(); } catch {}
      this.audio.restoreAudio();
    }
    this.browser.disconnect();
    if (this.vadProvider) {
      await this.vadProvider.dispose();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
```

**User contribution opportunity:** The `recordWithVAD()` method has two approaches:
1. Use the existing VAD provider on ffmpeg PCM stdout (precise but complex)
2. Use ffmpeg's `silencedetect` filter (simpler, less precise)

This is left as a TODO for implementation — start with ffmpeg silencedetect for MVP, refine to VAD provider later.

**Step 2: Export from index**

Add to `src/services/index.ts`:

```typescript
export { DmCallService } from './dm-call-service-v2.js';
export type { CallRequest, CallResult, ActiveCall } from './dm-call-service-v2.js';
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`

**Step 4: Commit**

```bash
git add src/services/dm-call-service-v2.ts src/services/index.ts
git commit -m "feat: add DmCallService call orchestration"
```

---

### Task 5: Create DmCallApi — Express routes

**Files:**
- Create: `src/services/dm-call-api.ts`

Thin Express router layer. Delegates everything to `DmCallService`.

**Step 1: Create DmCallApi class**

```typescript
import express, { type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { logger } from '../utils/logger.js';
import { DmCallService } from './dm-call-service-v2.js';

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

  async start(): Promise<void> { /* like BotApiServer */ }
  async stop(): Promise<void> { /* like BotApiServer */ }

  private setupRoutes(): void {
    // GET /health
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', service: 'dm-call' });
    });

    // POST /call — Start a DM call
    this.app.post('/call', async (req: Request, res: Response) => {
      const { userId, message, callbackUrl, channelId } = req.body;

      if (!userId || !message || !callbackUrl) {
        res.status(400).json({ error: 'userId, message, and callbackUrl are required' });
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
        const callId = await this.callService.startCall({ userId, message, callbackUrl, channelId });
        res.status(202).json({ callId, status: 'calling' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // GET /call/:callId — Check call status
    this.app.get('/call/:callId', (req: Request, res: Response) => {
      const { callId } = req.params;

      // Check active call
      if (this.callService.currentCall?.callId === callId) {
        res.json({
          callId,
          status: this.callService.currentCall.status,
          startedAt: this.callService.currentCall.startedAt,
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
  }
}
```

**Step 2: Export from index**

Add to `src/services/index.ts`:
```typescript
export { DmCallApi } from './dm-call-api.js';
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`

**Step 4: Commit**

```bash
git add src/services/dm-call-api.ts src/services/index.ts
git commit -m "feat: add DmCallApi Express routes"
```

---

### Task 6: Create dm-call-main.ts — Standalone entrypoint

**Files:**
- Create: `src/dm-call-main.ts`

Standalone entrypoint that initializes DmCallService + DmCallApi and starts the server.

**Step 1: Create entrypoint**

```typescript
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { DmCallService } from './services/dm-call-service-v2.js';
import { DmCallApi } from './services/dm-call-api.js';

async function main() {
  logger.info('Starting DM-Call Service...');

  const callService = new DmCallService();
  await callService.initialize();

  const api = new DmCallApi(config.dmCall.port, callService);
  await api.start();

  logger.info(`DM-Call Service ready on port ${config.dmCall.port}`);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down DM-Call Service...');
    await callService.dispose();
    await api.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error(`Fatal: ${error.message}`);
  process.exit(1);
});
```

**Step 2: Add npm script to package.json**

Add to `scripts` in `package.json`:

```json
"dm-call": "tsx src/dm-call-main.ts",
"dm-call:dev": "tsx watch src/dm-call-main.ts"
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`

**Step 4: Commit**

```bash
git add src/dm-call-main.ts package.json
git commit -m "feat: add DM-Call service standalone entrypoint"
```

---

### Task 7: Update OpenClaw plugin with dm-call channel

**Files:**
- Modify: `openclaw-extension/index.ts`
- Modify: `openclaw-extension/openclaw.plugin.json`

**Step 1: Add dm-call channel registration**

In `openclaw-extension/index.ts`, after the existing `discord-voice` channel registration, add a second channel:

```typescript
// Register DM-Call channel (outbound: agent -> dm-call service)
const dmCallServiceUrl = (config as any).dmCallServiceUrl ?? 'http://localhost:8792';

pluginApi.registerChannel({
  plugin: {
    id: "discord-dm-call",
    meta: {
      id: "discord-dm-call",
      label: "Discord DM Call",
      selectionLabel: "Discord DM Voice Call",
      docsPath: "/channels/discord-dm-call",
      blurb: "Call Discord users via DM voice call.",
      aliases: ["dm-call", "call"],
    },
    capabilities: {
      chatTypes: ["direct"] as const,
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
      sendText: async (opts: { text: string; context?: any }) => {
        try {
          const res = await fetch(`${dmCallServiceUrl}/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: opts.context?.userId,
              message: opts.text,
              callbackUrl: `http://127.0.0.1:${inboundPort}/inbound`,
              channelId: "dm-call",
            }),
          });

          if (res.status === 409) {
            console.log("[discord-dm-call] Call already in progress");
            return { ok: false, error: "Call already in progress" };
          }

          return { ok: res.ok };
        } catch (err) {
          console.error(`[discord-dm-call] Call failed: ${err}`);
          return { ok: false };
        }
      },
    },
  },
});
```

**Step 2: Update plugin manifest**

Add `dmCallServiceUrl` to config schema:

```json
"dmCallServiceUrl": {
  "type": "string",
  "default": "http://localhost:8792",
  "description": "DM-Call service API URL"
}
```

Bump version to `0.3.0`.

**Step 3: Commit**

```bash
git add openclaw-extension/index.ts openclaw-extension/openclaw.plugin.json
git commit -m "feat: add discord-dm-call channel to OpenClaw plugin"
```

---

### Task 8: Manual integration test

**No files to create — manual verification steps.**

**Step 1: Start Chrome with remote debugging**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Login to Discord in the browser.

**Step 2: Start DM-Call Service**

```bash
npm run dm-call:dev
```

Expected: `DM-Call Service ready on port 8792`

**Step 3: Test health endpoint**

```bash
curl http://localhost:8792/health
```

Expected: `{"status":"ok","service":"dm-call"}`

**Step 4: Test call (with a test callback)**

Start a simple callback receiver:
```bash
npx http-echo-server 9999
```

Then trigger a call:
```bash
curl -X POST http://localhost:8792/call \
  -H "Content-Type: application/json" \
  -d '{"userId":"YOUR_DISCORD_ID","message":"Hey, kurze Frage: was machst du gerade?","callbackUrl":"http://localhost:9999/callback"}'
```

Expected: `202 { callId: "call_xxx", status: "calling" }`

**Step 5: Verify call flow**

1. Browser should navigate to DM
2. Call should start ringing
3. Answer the call on your phone/desktop Discord
4. Bot should speak the greeting
5. Say something in response
6. After ~1.5s silence → call should hang up
7. Callback should receive transcription

**Step 6: Test 409 (concurrent call)**

While a call is active:
```bash
curl -X POST http://localhost:8792/call \
  -H "Content-Type: application/json" \
  -d '{"userId":"OTHER_ID","message":"test","callbackUrl":"http://localhost:9999"}'
```

Expected: `409 { error: "A call is already in progress" }`

---

## Task Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add DM-Call config options | `src/config.ts` |
| 2 | Create DiscordBrowser (CDP layer) | `src/services/discord-browser.ts` |
| 3 | Create AudioBridge (BlackHole routing) | `src/services/audio-bridge.ts` |
| 4 | Create DmCallService (orchestration) | `src/services/dm-call-service-v2.ts`, `src/services/index.ts` |
| 5 | Create DmCallApi (Express routes) | `src/services/dm-call-api.ts`, `src/services/index.ts` |
| 6 | Create standalone entrypoint | `src/dm-call-main.ts`, `package.json` |
| 7 | Update OpenClaw plugin with dm-call channel | `openclaw-extension/index.ts`, `openclaw-extension/openclaw.plugin.json` |
| 8 | Manual integration test | — |

## Dependencies

- Tasks 2, 3 can be implemented in parallel
- Task 4 depends on Tasks 2 + 3
- Task 5 depends on Task 4
- Task 6 depends on Tasks 4 + 5
- Task 7 is independent (OpenClaw side)
- Task 8 depends on all others

## Notes

- The `recordWithVAD()` implementation in Task 4 has two approaches. Start with ffmpeg `silencedetect` filter for MVP simplicity. Refine to use the existing VAD provider for better precision in a follow-up.
- File `src/services/dm-call-service-v2.ts` is named v2 to avoid conflict with the existing prototype at `src/services/dm-call-service.ts`. The old file can be deleted once v2 is stable.
- The existing prototype files (`scripts/dm-call-mvp.ts`, `src/services/dm-call-service.ts`) serve as proven reference implementations for CDP patterns, audio routing, and call flow.
