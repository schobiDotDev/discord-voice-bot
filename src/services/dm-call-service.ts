import express from "express";
import WebSocket from "ws";
import { execSync, spawn } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../..");

config({ path: join(projectRoot, ".env") });

const PORT = 8788;
const CDP_HOST = "http://127.0.0.1:18800";
const TTS_URL = "http://127.0.0.1:8787";
const STT_URL = process.env.STT_API_URL || "https://api.openai.com/v1/audio/transcriptions";
const STT_KEY = process.env.STT_API_KEY!;
const STT_MODEL = process.env.STT_MODEL || "whisper-1";
const DM_CHANNEL = "https://discord.com/channels/@me/1469647713690718354";
const RECORDINGS_DIR = join(projectRoot, "recordings");
const DEFAULT_SPEAKER = "MacBook Air-Lautsprecher";

// Load the audio capture patch JS
const AUDIO_CAPTURE_PATCH = readFileSync(
  join(projectRoot, "scripts/audio-capture-patch.js"),
  "utf-8"
);

mkdirSync(RECORDINGS_DIR, { recursive: true });

type State = "idle" | "calling" | "connected" | "speaking" | "listening";
let state: State = "idle";
let cdpWs: WebSocket | null = null;
let cdpId = 0;

function setState(s: State) {
  state = s;
  logger.info(`[state] ${s}`);
}

function switchAudio(device: string) {
  execSync(`SwitchAudioSource -s "${device}" -t output`, { stdio: "pipe" });
  logger.info(`[audio] output → ${device}`);
}

function restoreAudio() {
  try { switchAudio(DEFAULT_SPEAKER); } catch {}
}

async function findDiscordTargetId(): Promise<string> {
  const res = await fetch(`${CDP_HOST}/json/list`);
  const pages = (await res.json()) as any[];
  const page = pages.find((p: any) => p.url?.includes("discord.com"));
  if (!page) throw new Error("No Discord page found in CDP");
  return page.id;
}

async function connectCDP(): Promise<void> {
  const targetId = await findDiscordTargetId();
  const wsUrl = `ws://127.0.0.1:18800/devtools/page/${targetId}`;
  logger.info(`[cdp] connecting to ${wsUrl}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      cdpWs = ws;
      cdpId = 0;
      logger.info("[cdp] connected");
      resolve();
    });
    ws.on("error", reject);
    ws.on("close", () => { cdpWs = null; });
  });
}

function cdpSend(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!cdpWs) return reject(new Error("CDP not connected"));
    const id = ++cdpId;
    const msg = JSON.stringify({ id, method, params });
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    const handler = (data: WebSocket.Data) => {
      const resp = JSON.parse(data.toString());
      if (resp.id === id) {
        clearTimeout(timeout);
        cdpWs!.off("message", handler);
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      }
    };
    cdpWs.on("message", handler);
    cdpWs.send(msg);
  });
}

async function cdpEval(expression: string): Promise<any> {
  const result = await cdpSend("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function navigateToDM() {
  const currentUrl = await cdpEval(`window.location.href`);
  if (currentUrl?.includes("1469647713690718354")) {
    logger.info("[nav] already on DM page");
    return;
  }
  await cdpEval(`window.location.href = '${DM_CHANNEL}'`);
  await sleep(2500);
}

async function ensureUnmuted() {
  const unmuted = await cdpEval(`
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
  `);
  logger.info("[mute] " + unmuted);
}

async function injectAudioCapture() {
  // Inject the tab audio capture patch
  const result = await cdpEval(AUDIO_CAPTURE_PATCH);
  logger.info("[audio-capture] inject:", result);
  if (result !== "injected" && result !== "already-injected") {
    throw new Error(`Audio capture injection failed: ${result}`);
  }
  // Initialize tab audio capture (getDisplayMedia)
  const initResult = await cdpEval(`window.__audioCapture.init()`);
  logger.info("[audio-capture] init:", initResult);
  if (initResult !== "initialized" && initResult !== "already-initialized") {
    throw new Error(`Audio capture init failed: ${initResult}`);
  }
}

async function startCall() {
  await ensureUnmuted();
  await sleep(300);

  const result = await cdpEval(`
    (() => {
      if (document.querySelector('[aria-label="Disconnect"]')) return 'already-connected';
      const startBtn = document.querySelector('[aria-label="Start Voice Call"]');
      if (startBtn) { startBtn.click(); return 'started'; }
      const joinBtn = document.querySelector('[aria-label="Join Call"]') || document.querySelector('[aria-label="Join Voice Call"]');
      if (joinBtn) { joinBtn.click(); return 'joined'; }
      return 'no-button';
    })()
  `);
  logger.info("[call] " + result);
  if (result === "no-button") throw new Error("No call button found");
}

async function waitForConnection(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await cdpEval(`
      (() => {
        if (document.querySelector('[aria-label="Disconnect"]')) return 'connected';
        const text = document.body.innerText;
        if (text.includes('Voice Connected')) return 'connected';
        if (text.includes('Calling') || text.includes('Ringing')) return 'ringing';
        if (document.querySelector('[aria-label="Join Call"]')) return 'needs-join';
        return 'waiting';
      })()
    `);

    if (status === "connected") return;
    if (status === "needs-join") {
      logger.info("[call] joining call...");
      await cdpEval(`document.querySelector('[aria-label="Join Call"]')?.click()`);
      await sleep(2000);
    }

    logger.info(`[call] ${status}...`);
    await sleep(1500);
  }
  throw new Error("Call connection timeout");
}

async function hangup() {
  try {
    await cdpEval(`document.querySelector('[aria-label="Disconnect"]')?.click()`);
    logger.info("[call] disconnected");
  } catch {}
}

async function generateTTS(text: string): Promise<string> {
  const outPath = join(RECORDINGS_DIR, `tts-${Date.now()}.wav`);
  const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "tts-1",
      voice: "thorsten",
      input: text,
      response_format: "wav",
      speed: 1.1,
    }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
  return outPath;
}

function playAudio(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("afplay", [filePath]);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`afplay exit ${code}`))
    );
    proc.on("error", reject);
  });
}

async function speakInCall(text: string) {
  setState("speaking");
  const wavPath = await generateTTS(text);
  try {
    // Switch system output to BlackHole 2ch so afplay goes into Discord mic
    switchAudio("BlackHole 2ch");
    await playAudio(wavPath);
    // Switch back (not critical for recording anymore since we capture in-browser)
    switchAudio(DEFAULT_SPEAKER);
  } finally {
    try { unlinkSync(wavPath); } catch {}
    setState("connected");
  }
}

// ---- Browser-based recording (replaces BlackHole/ffmpeg) ----

async function startBrowserRecording() {
  const result = await cdpEval(`window.__audioCapture.startRecording()`);
  logger.info("[rec] startRecording:", result);
  if (result !== "recording") {
    logger.warn("[rec] unexpected startRecording result:", result);
  }
  return result;
}

async function stopBrowserRecording(): Promise<string | null> {
  const b64 = await cdpEval(`window.__audioCapture.stopRecording()`);
  logger.info("[rec] stopRecording: got", b64 ? `${b64.length} chars` : "null");
  return b64;
}

async function transcribeBase64Audio(b64: string): Promise<string> {
  // Decode base64 to buffer
  const audioBuffer = Buffer.from(b64, "base64");
  const tmpPath = join(RECORDINGS_DIR, `rec-${Date.now()}.webm`);
  writeFileSync(tmpPath, audioBuffer);

  // Convert webm to wav for Whisper
  const wavPath = tmpPath.replace(".webm", ".wav");
  try {
    execSync(`ffmpeg -y -i "${tmpPath}" -ar 16000 -ac 1 "${wavPath}"`, { stdio: "pipe" });
  } catch (err) {
    // If conversion fails, try sending webm directly
    logger.warn("[stt] ffmpeg conversion failed, trying webm directly");
  }

  const filePath = existsSync(wavPath) ? wavPath : tmpPath;
  const audioData = readFileSync(filePath);
  const formData = new FormData();
  const ext = filePath.endsWith(".wav") ? "wav" : "webm";
  formData.append("file", new Blob([audioData], { type: `audio/${ext}` }), `audio.${ext}`);
  formData.append("model", STT_MODEL);
  formData.append("language", "de");

  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${STT_KEY}` },
    body: formData,
  });

  // Cleanup
  try { unlinkSync(tmpPath); } catch {}
  try { unlinkSync(wavPath); } catch {}

  if (!res.ok) throw new Error(`STT failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.text || "";
}

async function listenInCall(seconds = 10): Promise<string> {
  setState("listening");

  // Recording already started in call flow
  logger.info(`[rec] listening for ${seconds}s...`);
  await sleep(seconds * 1000);

  // Stop and get audio
  const b64Audio = await stopBrowserRecording();
  setState("connected");

  if (!b64Audio) {
    logger.warn("[rec] No audio captured");
    return "";
  }

  // Transcribe
  return await transcribeBase64Audio(b64Audio);
}

async function cleanup() {
  try {
    await cdpEval(`window.__audioCapture?.reset()`);
  } catch {}
  try { await hangup(); } catch {}
  restoreAudio();
  if (cdpWs) { cdpWs.close(); cdpWs = null; }
  setState("idle");
}

// Express API
const app = express();
app.use(express.json());

app.get("/status", (_req, res) => {
  res.json({ state });
});

app.post("/call", async (req, res) => {
  if (state !== "idle") { res.status(409).json({ error: `Busy: ${state}` }); return; }
  const { message, listenSeconds = 10 } = req.body;
  if (!message) { res.status(400).json({ error: "message required" }); return; }

  const startTime = Date.now();
  try {
    setState("calling");
    await connectCDP();
    await navigateToDM();

    // Inject and initialize tab audio capture (getDisplayMedia)
    await injectAudioCapture();

    await startCall();
    await waitForConnection();
    setState("connected");
    await ensureUnmuted();

    // Wait for audio to stabilize
    logger.info("[call] waiting for audio to stabilize...");
    await sleep(2000);

    // Start recording (tab capture is already initialized)
    await startBrowserRecording();
    await sleep(500);

    await speakInCall(message);
    await sleep(1000); // pause after speaking

    // Wait for user response
    logger.info(`[rec] listening for ${listenSeconds}s...`);
    await sleep(listenSeconds * 1000);

    // Stop recording and get audio
    const b64Audio = await stopBrowserRecording();

    await hangup();
    restoreAudio();
    if (cdpWs) { cdpWs.close(); cdpWs = null; }
    setState("idle");

    if (!b64Audio) {
      res.json({ success: true, transcription: "", note: "no-audio-captured", durationMs: Date.now() - startTime });
      return;
    }

    const transcription = await transcribeBase64Audio(b64Audio);
    res.json({ success: true, transcription, durationMs: Date.now() - startTime });
  } catch (err: any) {
    logger.error("[call] error:", err);
    await cleanup();
    res.status(500).json({ error: err.message, durationMs: Date.now() - startTime });
  }
});

app.post("/speak", async (req, res) => {
  if (state !== "connected") {
    res.status(409).json({ error: `Not in call: ${state}` });
    return;
  }
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: "text required" });
    return;
  }
  try {
    await speakInCall(text);
    res.json({ success: true });
  } catch (err: any) {
    logger.error("[speak] error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/listen", async (req, res) => {
  if (state !== "connected") {
    res.status(409).json({ error: `Not in call: ${state}` });
    return;
  }
  const { seconds = 10 } = req.body || {};
  try {
    const transcription = await listenInCall(seconds);
    res.json({ success: true, transcription });
  } catch (err: any) {
    logger.error("[listen] error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/hangup", async (_req, res) => {
  if (state === "idle") {
    res.json({ success: true, message: "Already idle" });
    return;
  }
  try {
    await cleanup();
    res.json({ success: true });
  } catch (err: any) {
    logger.error("[hangup] error:", err);
    restoreAudio();
    setState("idle");
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  logger.info(`[dm-call-service] running on http://localhost:${PORT}`);
});

// Cleanup on exit
process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });
process.on("uncaughtException", async (err) => {
  logger.error("[fatal]", err);
  await cleanup();
  process.exit(1);
});
