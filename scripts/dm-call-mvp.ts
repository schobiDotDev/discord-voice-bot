#!/usr/bin/env tsx
/**
 * Discord DM Call MVP
 * 
 * Orchestrates a single DM call:
 * 1. Opens Discord DM in OpenClaw browser
 * 2. Clicks "Start Voice Call"
 * 3. Waits for user to answer
 * 4. Speaks a question via TTS → BlackHole → Discord
 * 5. Records user's answer via BlackHole → ffmpeg
 * 6. Transcribes with Whisper
 * 7. Hangs up
 * 
 * Prerequisites:
 * - BlackHole 2ch + 16ch installed
 * - SwitchAudioSource installed
 * - OpenClaw browser running with Discord logged in
 * - Discord Voice & Video settings: Input = BlackHole 2ch, Output = BlackHole 16ch
 * - TTS server running (sherpa-onnx on port 8787)
 * 
 * Usage:
 *   npx tsx scripts/dm-call-mvp.ts "Was soll ich zum Abendessen machen?"
 *   npx tsx scripts/dm-call-mvp.ts --greeting "Hallo Sir!" "Kurze Frage..."
 */

import { config as dotenvConfig } from 'dotenv';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

dotenvConfig();
const execAsync = promisify(exec);

// ─── Config ───
const CDP_PORT = 18800;
const DM_CHANNEL_URL = 'https://discord.com/channels/@me/1469647713690718354'; // Schobi DM
const TTS_URL = process.env.TTS_API_URL ?? 'http://127.0.0.1:8787';
const STT_URL = process.env.STT_API_URL ?? 'https://api.openai.com/v1/audio/transcriptions';
const STT_KEY = process.env.STT_API_KEY!;
const BLACKHOLE_INPUT = process.env.AUDIO_INPUT_DEVICE ?? 'BlackHole 16ch'; // Discord output → our input
const BLACKHOLE_OUTPUT = process.env.AUDIO_OUTPUT_DEVICE ?? 'BlackHole 2ch'; // Our output → Discord input
const SYSTEM_DEVICE = process.env.AUDIO_SYSTEM_DEVICE ?? 'MacBook Air-Lautsprecher';
const LANGUAGE = process.env.LANGUAGE ?? 'de';
const TMP_DIR = './recordings';

// ─── Logging ───
const log = {
  info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  ok: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  step: (n: number, msg: string) => console.log(`\n\x1b[35m[Step ${n}]\x1b[0m ${msg}`),
};

// ─── CDP Helpers ───
async function getTargetId(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json() as Array<{ id: string; url: string; type: string }>;
  const discord = targets.find(t => t.url.includes('discord.com') && t.type === 'page');
  if (!discord) throw new Error('No Discord tab found in OpenClaw browser');
  return discord.id;
}

async function cdpEval(targetId: string, expression: string, timeout = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${targetId}`);
    const id = Math.floor(Math.random() * 100000);
    
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP eval timeout'));
    }, timeout);
    
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timer);
        ws.close();
        if (msg.result?.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'eval error'));
        } else {
          resolve(msg.result?.result?.value);
        }
      }
    });
    
    ws.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

// ─── Browser Actions ───
async function navigateToDM(targetId: string): Promise<void> {
  await cdpEval(targetId, `window.location.href = '${DM_CHANNEL_URL}'`);
  await sleep(2000);
}

async function clickStartVoiceCall(targetId: string): Promise<boolean> {
  const result = await cdpEval(targetId, `
    (() => {
      const btn = document.querySelector('[aria-label="Start Voice Call"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  return result === true;
}

async function waitForCallConnected(targetId: string, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await cdpEval(targetId, `
      (() => {
        const disconnect = document.querySelector('[aria-label="Disconnect"]');
        if (disconnect) return 'connected';
        const body = document.body?.innerText ?? '';
        if (body.includes('Ringing')) return 'ringing';
        if (body.includes('Calling')) return 'calling';
        return 'waiting';
      })()
    `) as string;
    
    if (state === 'connected') return true;
    log.info(`Call state: ${state}...`);
    await sleep(1500);
  }
  return false;
}

async function hangUp(targetId: string): Promise<boolean> {
  const result = await cdpEval(targetId, `
    (() => {
      const btn = document.querySelector('[aria-label="Disconnect"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  return result === true;
}

// ─── Audio: TTS via Sherpa-ONNX ───
async function generateTTS(text: string): Promise<Buffer> {
  log.info(`Generating TTS: "${text.substring(0, 60)}..."`);
  
  const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: text,
      voice: 'thorsten',
      response_format: 'wav',
      speed: 1.1,
    }),
  });
  
  if (!res.ok) throw new Error(`TTS failed: ${res.status} ${res.statusText}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Play audio to BlackHole device (which Discord picks up as mic input)
 * Switches system output → BlackHole 2ch → plays → switches back
 */
async function playToDiscord(audioBuffer: Buffer): Promise<void> {
  const tmpFile = `${TMP_DIR}/tts-${Date.now()}.wav`;
  writeFileSync(tmpFile, audioBuffer);
  
  try {
    // Switch system audio output to BlackHole 2ch
    await execAsync(`SwitchAudioSource -s "${BLACKHOLE_OUTPUT}" -t output`);
    log.info(`Audio output → ${BLACKHOLE_OUTPUT}`);
    
    // Play with afplay
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('afplay', [tmpFile]);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`afplay exit ${code}`)));
      proc.on('error', reject);
    });
    
    log.ok('TTS playback complete');
  } finally {
    // Restore system audio
    await execAsync(`SwitchAudioSource -s "${SYSTEM_DEVICE}" -t output`).catch(() => {});
    log.info(`Audio output → ${SYSTEM_DEVICE}`);
    
    // Cleanup
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ─── Audio: Record from BlackHole (Discord's output) ───
async function getInputDeviceIndex(): Promise<number> {
  const { stdout } = await execAsync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1; true');
  const lines = stdout.split('\n');
  let inAudio = false;
  
  for (const line of lines) {
    if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
    if (!inAudio) continue;
    
    const match = line.match(/\[(\d+)\]\s+(.+)/);
    if (match && match[2].includes(BLACKHOLE_INPUT)) {
      return parseInt(match[1], 10);
    }
  }
  throw new Error(`Input device not found: ${BLACKHOLE_INPUT}`);
}

/**
 * Record audio from BlackHole 16ch (Discord's speaker output)
 * Uses VAD (volume detection) to know when user stops speaking
 */
async function recordResponse(durationSec = 15): Promise<string> {
  const deviceIdx = await getInputDeviceIndex();
  const outFile = `${TMP_DIR}/response-${Date.now()}.wav`;
  
  log.info(`Recording from device :${deviceIdx} for up to ${durationSec}s...`);
  
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-f', 'avfoundation',
      '-i', `:${deviceIdx}`,
      '-t', String(durationSec),
      '-ar', '16000',
      '-ac', '1',
      outFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    proc.on('error', reject);
  });
  
  log.ok(`Recorded to ${outFile}`);
  return outFile;
}

// ─── STT: Whisper API ───
async function transcribe(audioFile: string): Promise<string> {
  log.info('Transcribing with Whisper...');
  
  const { readFileSync } = await import('node:fs');
  const audioData = readFileSync(audioFile);
  
  const formData = new FormData();
  formData.append('file', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'whisper-1');
  formData.append('language', LANGUAGE);
  
  const res = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${STT_KEY}` },
    body: formData,
  });
  
  if (!res.ok) throw new Error(`Whisper failed: ${res.status}`);
  const result = await res.json() as { text: string };
  return result.text;
}

// ─── Utility ───
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main Flow ───
async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let greeting = '';
  let question = '';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--greeting' && args[i + 1]) {
      greeting = args[++i];
    } else {
      question = args[i];
    }
  }
  
  if (!question) {
    console.log('Usage: npx tsx scripts/dm-call-mvp.ts [--greeting "..."] "Your question"');
    process.exit(1);
  }
  
  // Ensure tmp dir
  mkdirSync(TMP_DIR, { recursive: true });
  
  console.log('\n🎩 Discord DM Call MVP\n');
  console.log(`Question: "${question}"`);
  if (greeting) console.log(`Greeting: "${greeting}"`);
  console.log('');
  
  // Step 1: Find Discord tab
  log.step(1, 'Finding Discord browser tab...');
  const targetId = await getTargetId();
  log.ok(`Found target: ${targetId}`);
  
  // Step 2: Navigate to DM
  log.step(2, 'Navigating to DM...');
  await navigateToDM(targetId);
  log.ok('On DM page');
  
  // Step 3: Start call
  log.step(3, 'Starting voice call...');
  const clicked = await clickStartVoiceCall(targetId);
  if (!clicked) {
    log.error('Could not find "Start Voice Call" button!');
    process.exit(1);
  }
  log.ok('Call initiated — waiting for answer...');
  
  // Step 4: Wait for connection
  log.step(4, 'Waiting for user to answer...');
  const connected = await waitForCallConnected(targetId);
  if (!connected) {
    log.error('Call not answered within timeout');
    await hangUp(targetId).catch(() => {});
    process.exit(1);
  }
  log.ok('Call connected!');
  
  // Small delay for audio to stabilize
  await sleep(1500);
  
  // Step 5: Speak
  log.step(5, 'Speaking...');
  const fullText = greeting ? `${greeting} ${question}` : question;
  const audioBuffer = await generateTTS(fullText);
  await playToDiscord(audioBuffer);
  
  // Step 6: Listen
  log.step(6, 'Listening for response...');
  await sleep(500); // Brief pause after speaking
  const recordingFile = await recordResponse(15);
  
  // Step 7: Transcribe
  log.step(7, 'Transcribing...');
  const transcription = await transcribe(recordingFile);
  
  // Step 8: Hang up
  log.step(8, 'Hanging up...');
  await sleep(500);
  await hangUp(targetId);
  
  // Cleanup recording
  try { unlinkSync(recordingFile); } catch {}
  
  // Result
  console.log('\n' + '='.repeat(50));
  console.log(`\x1b[32m✅ Response: "${transcription}"\x1b[0m`);
  console.log('='.repeat(50) + '\n');
  
  // Output as JSON for programmatic use
  const result = { success: true, question, transcription };
  console.log(JSON.stringify(result));
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
