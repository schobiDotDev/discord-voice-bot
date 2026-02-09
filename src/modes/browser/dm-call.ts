/**
 * Discord DM Call MVP — Browser Automation via CDP
 * 
 * Flow:
 * 1. Navigate to DM with target user
 * 2. Click "Start Voice Call"
 * 3. Wait for call to connect
 * 4. Play TTS greeting/question via injected audio
 * 5. Record user's response via MediaRecorder
 * 6. Transcribe with Whisper
 * 7. Hang up
 * 
 * Uses Chrome DevTools Protocol (CDP) through OpenClaw's browser control.
 * Audio is played/captured via Web APIs injected into the Discord page.
 */

import { config as dotenvConfig } from 'dotenv';
import express from 'express';
import { WhisperAPIProvider } from '../../providers/stt/whisper-api.js';
import { SherpaOnnxProvider } from '../../providers/tts/sherpa-onnx.js';
import type { STTProvider } from '../../providers/stt/interface.js';
import type { TTSProvider } from '../../providers/tts/interface.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import logger from '../../utils/logger.js';

dotenvConfig();

// CDP connection to OpenClaw browser
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:18800';

interface CallResult {
  success: boolean;
  transcription?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Send a CDP command via HTTP
 */
async function cdpSend(targetId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = `${CDP_URL}/json/protocol`;
  // Use the /json endpoint to send commands
  // Actually, we need WebSocket for CDP. Let's use fetch to the OpenClaw browser API instead.
  // OpenClaw browser tool uses its own API, but we can also use the raw CDP WebSocket.
  
  // For now, let's use a simpler approach: evaluate JS directly via the REST API
  throw new Error('Use evaluateInBrowser instead');
}

/**
 * Evaluate JavaScript in the browser page via CDP WebSocket
 */
async function evaluateInBrowser(targetId: string, expression: string): Promise<unknown> {
  const { default: WebSocket } = await import('ws');
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:18800/devtools/page/${targetId}`);
    const id = Math.floor(Math.random() * 100000);
    
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP evaluation timeout'));
    }, 30000);
    
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }
      }));
    });
    
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.close();
        if (msg.result?.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'Evaluation error'));
        } else {
          resolve(msg.result?.result?.value);
        }
      }
    });
    
    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Click an element via CDP
 */
async function clickElement(targetId: string, selector: string): Promise<boolean> {
  const result = await evaluateInBrowser(targetId, `
    (() => {
      const el = document.querySelector('${selector}');
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  return result === true;
}

/**
 * Click element by aria-label
 */
async function clickByAriaLabel(targetId: string, label: string): Promise<boolean> {
  const result = await evaluateInBrowser(targetId, `
    (() => {
      const el = document.querySelector('[aria-label="${label}"]');
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  return result === true;
}

/**
 * Wait for call to be connected by checking for disconnect button
 */
async function waitForCallConnected(targetId: string, timeoutMs = 30000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const connected = await evaluateInBrowser(targetId, `
      (() => {
        // Look for the disconnect/hangup button which appears when call is active
        const disconnectBtn = document.querySelector('[aria-label="Disconnect"]') 
          || document.querySelector('[aria-label="Leave Call"]');
        // Also check for "Ringing" or connected state text
        const ringing = document.body.innerText.includes('Ringing');
        const connected = !!disconnectBtn;
        return { connected, ringing };
      })()
    `) as { connected: boolean; ringing: boolean } | null;
    
    if (connected?.connected) {
      logger.info('Call connected!');
      return true;
    }
    if (connected?.ringing) {
      logger.debug('Ringing...');
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  logger.error('Call connection timeout');
  return false;
}

/**
 * Inject audio capture/playback infrastructure into the page
 */
async function injectAudioInfra(targetId: string): Promise<void> {
  await evaluateInBrowser(targetId, `
    (() => {
      if (window.__thomaschAudio) return 'already injected';
      
      window.__thomaschAudio = {
        // Store for audio operations
        recorder: null,
        chunks: [],
        stream: null,
        isRecording: false,
        
        // Play audio from a URL (e.g. TTS output)
        playAudio: (url) => {
          return new Promise((resolve, reject) => {
            const audio = new Audio(url);
            audio.onended = () => resolve('done');
            audio.onerror = (e) => reject(e);
            audio.play().catch(reject);
          });
        },
        
        // Play audio from base64 data
        playBase64: (b64, mimeType = 'audio/wav') => {
          return new Promise((resolve, reject) => {
            const audio = new Audio('data:' + mimeType + ';base64,' + b64);
            audio.onended = () => resolve('done');
            audio.onerror = (e) => reject(e);
            audio.play().catch(reject);
          });
        },
      };
      
      return 'injected';
    })()
  `);
  logger.info('Audio infrastructure injected');
}

/**
 * Play TTS audio in the browser
 * Generates TTS locally, then injects the audio into the Discord page
 */
async function playTTSInBrowser(targetId: string, ttsProvider: TTSProvider, text: string): Promise<void> {
  logger.info(`Speaking: "${text}"`);
  
  // Generate TTS audio
  const audioBuffer = await ttsProvider.synthesize(text);
  
  // Convert to base64
  const b64 = Buffer.from(audioBuffer).toString('base64');
  
  // Play in browser
  await evaluateInBrowser(targetId, `
    window.__thomaschAudio.playBase64('${b64}', 'audio/wav')
  `);
  
  logger.info('TTS playback complete');
}

/**
 * Record audio from the call using MediaRecorder
 * This captures what the OTHER person is saying (the remote audio stream)
 */
async function startRecording(targetId: string): Promise<void> {
  await evaluateInBrowser(targetId, `
    (async () => {
      const ta = window.__thomaschAudio;
      
      // Try to capture audio from the page
      // Discord uses WebRTC, so we can try to intercept the remote audio stream
      // or use the Audio Context destination
      
      // Method: Capture all audio output from the page using AudioContext
      if (!ta.audioContext) {
        ta.audioContext = new AudioContext({ sampleRate: 16000 });
      }
      
      // Create a MediaStreamDestination to capture mixed audio
      const dest = ta.audioContext.createMediaStreamDestination();
      
      // Hook into all audio/video elements on the page
      const mediaElements = document.querySelectorAll('audio, video');
      mediaElements.forEach(el => {
        try {
          const source = ta.audioContext.createMediaElementSource(el);
          source.connect(dest);
          source.connect(ta.audioContext.destination); // Also play to speakers
        } catch(e) {
          // Element might already be connected
        }
      });
      
      ta.chunks = [];
      ta.recorder = new MediaRecorder(dest.stream, { 
        mimeType: 'audio/webm;codecs=opus' 
      });
      
      ta.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) ta.chunks.push(e.data);
      };
      
      ta.recorder.start(500); // Collect chunks every 500ms
      ta.isRecording = true;
      
      return 'recording started';
    })()
  `);
  logger.info('Recording started');
}

/**
 * Stop recording and get the audio as base64
 */
async function stopRecording(targetId: string): Promise<string | null> {
  const result = await evaluateInBrowser(targetId, `
    new Promise((resolve) => {
      const ta = window.__thomaschAudio;
      if (!ta.recorder || !ta.isRecording) {
        resolve(null);
        return;
      }
      
      ta.recorder.onstop = async () => {
        const blob = new Blob(ta.chunks, { type: 'audio/webm' });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        resolve(btoa(binary));
        ta.isRecording = false;
      };
      
      ta.recorder.stop();
    })
  `);
  
  logger.info(`Recording stopped, got ${result ? 'audio data' : 'no data'}`);
  return result as string | null;
}

/**
 * Hang up the call
 */
async function hangUp(targetId: string): Promise<boolean> {
  return clickByAriaLabel(targetId, 'Disconnect');
}

/**
 * Main: Execute a single DM call
 */
export async function executeDMCall(
  targetId: string,
  question: string,
  options: {
    sttProvider: STTProvider;
    ttsProvider: TTSProvider;
    listenDurationMs?: number;
    greeting?: string;
  }
): Promise<CallResult> {
  const startTime = Date.now();
  const listenDuration = options.listenDurationMs ?? 15000;
  
  try {
    // Step 1: Start call
    logger.info('Starting voice call...');
    const clicked = await clickByAriaLabel(targetId, 'Start Voice Call');
    if (!clicked) {
      return { success: false, error: 'Could not find Start Voice Call button' };
    }
    
    // Step 2: Wait for connection
    logger.info('Waiting for call to connect...');
    const connected = await waitForCallConnected(targetId, 60000);
    if (!connected) {
      return { success: false, error: 'Call connection timeout — user did not answer' };
    }
    
    // Step 3: Inject audio infrastructure
    await injectAudioInfra(targetId);
    
    // Small delay to let audio settle
    await new Promise(r => setTimeout(r, 1000));
    
    // Step 4: Speak the question
    const textToSpeak = options.greeting 
      ? `${options.greeting} ${question}` 
      : question;
    await playTTSInBrowser(targetId, options.ttsProvider, textToSpeak);
    
    // Step 5: Listen for response
    logger.info(`Listening for ${listenDuration}ms...`);
    await startRecording(targetId);
    await new Promise(r => setTimeout(r, listenDuration));
    const audioB64 = await stopRecording(targetId);
    
    // Step 6: Transcribe
    let transcription: string | undefined;
    if (audioB64) {
      const audioBuffer = Buffer.from(audioB64, 'base64');
      // Save temp file for Whisper
      const tmpPath = path.join(process.cwd(), 'recordings', `dm-call-${Date.now()}.webm`);
      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      fs.writeFileSync(tmpPath, audioBuffer);
      
      transcription = await options.sttProvider.transcribe(tmpPath);
      logger.info(`Transcription: "${transcription}"`);
      
      // Cleanup
      fs.unlinkSync(tmpPath);
    }
    
    // Step 7: Hang up
    logger.info('Hanging up...');
    await new Promise(r => setTimeout(r, 1000));
    await hangUp(targetId);
    
    return {
      success: true,
      transcription,
      durationMs: Date.now() - startTime,
    };
    
  } catch (error) {
    logger.error(`Call failed: ${error instanceof Error ? error.message : String(error)}`);
    // Try to hang up on error
    try { await hangUp(targetId); } catch {}
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Standalone API server for DM calls
 * POST /call { question: string, greeting?: string, listenMs?: number }
 * GET /status
 */
async function main() {
  const port = parseInt(process.env.API_PORT ?? '8788', 10);
  const targetId = process.env.BROWSER_TARGET_ID;
  
  if (!targetId) {
    logger.error('BROWSER_TARGET_ID is required (the CDP page target ID of Discord)');
    process.exit(1);
  }
  
  // Init providers
  const sttProvider = new WhisperAPIProvider({
    apiUrl: process.env.STT_API_URL ?? 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: process.env.STT_API_KEY,
    model: process.env.STT_MODEL ?? 'whisper-1',
  });
  
  const ttsProvider = new SherpaOnnxProvider({
    apiUrl: process.env.TTS_API_URL ?? 'http://127.0.0.1:8787',
    voice: process.env.TTS_VOICE ?? 'thorsten',
    speed: 1.1,
  });
  
  let callInProgress = false;
  
  const app = express();
  app.use(express.json());
  
  app.get('/status', (_req, res) => {
    res.json({ status: callInProgress ? 'in-call' : 'idle' });
  });
  
  app.post('/call', async (req, res) => {
    if (callInProgress) {
      res.status(409).json({ error: 'Call already in progress' });
      return;
    }
    
    const { question, greeting, listenMs } = req.body as {
      question: string;
      greeting?: string;
      listenMs?: number;
    };
    
    if (!question) {
      res.status(400).json({ error: 'question is required' });
      return;
    }
    
    callInProgress = true;
    try {
      const result = await executeDMCall(targetId, question, {
        sttProvider,
        ttsProvider,
        listenDurationMs: listenMs,
        greeting,
      });
      res.json(result);
    } finally {
      callInProgress = false;
    }
  });
  
  app.listen(port, () => {
    logger.info(`DM Call API ready at http://localhost:${port}`);
    logger.info(`  POST /call  { question, greeting?, listenMs? }`);
    logger.info(`  GET  /status`);
  });
}

// Run if executed directly
const isMain = process.argv[1]?.endsWith('dm-call.js') || process.argv[1]?.endsWith('dm-call.ts');
if (isMain) {
  main().catch(err => logger.error(`Main error: ${err instanceof Error ? err.message : String(err)}`));
}
