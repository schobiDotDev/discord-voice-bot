import { config as dotenvConfig } from 'dotenv';
import { AudioDeviceManager, type AudioDevicesConfig } from './audio-devices.js';
import { CallManager } from './call-manager.js';
import { ApiServer } from '../../services/api-server.js';
import { WhisperAPIProvider } from '../../providers/stt/whisper-api.js';
import { WhisperLocalProvider } from '../../providers/stt/whisper-local.js';
import { SherpaOnnxProvider } from '../../providers/tts/sherpa-onnx.js';
import { OpenAITTSProvider } from '../../providers/tts/openai-tts.js';
import { ElevenLabsProvider } from '../../providers/tts/elevenlabs.js';
import type { STTProvider } from '../../providers/stt/interface.js';
import type { TTSProvider } from '../../providers/tts/interface.js';
import logger from '../../utils/logger.js';

dotenvConfig();

/**
 * Create STT provider from env vars (avoids shared config dependency)
 */
function createSTTProviderFromEnv(): STTProvider {
  const provider = process.env.STT_PROVIDER ?? 'whisper-api';
  const apiUrl = process.env.STT_API_URL ?? 'https://api.openai.com/v1/audio/transcriptions';
  const apiKey = process.env.STT_API_KEY;
  const model = process.env.STT_MODEL ?? 'whisper-1';

  logger.info(`STT provider: ${provider}`);

  switch (provider) {
    case 'whisper-api':
      return new WhisperAPIProvider({ apiUrl, apiKey, model });
    case 'whisper-local':
      return new WhisperLocalProvider({ apiUrl, apiKey, model });
    default:
      throw new Error(`Unknown STT provider: ${provider}`);
  }
}

/**
 * Create TTS provider from env vars (avoids shared config dependency)
 */
function createTTSProviderFromEnv(): TTSProvider {
  const provider = process.env.TTS_PROVIDER ?? 'openai';
  const apiUrl = process.env.TTS_API_URL ?? 'https://api.openai.com/v1/audio/speech';
  const apiKey = process.env.TTS_API_KEY;
  const model = process.env.TTS_MODEL;
  const voice = process.env.TTS_VOICE ?? 'nova';

  logger.info(`TTS provider: ${provider}`);

  switch (provider) {
    case 'openai':
      return new OpenAITTSProvider({ apiUrl, apiKey, model, voice });
    case 'sherpa-onnx':
      return new SherpaOnnxProvider({ apiUrl, apiKey, model, voice, speed: 1.1 });
    case 'elevenlabs':
      return new ElevenLabsProvider({
        apiUrl: apiUrl || 'https://api.elevenlabs.io/v1',
        apiKey,
        model,
        voice,
      });
    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

/**
 * Start the bot in browser mode
 * Sets up virtual audio devices and exposes a REST/WS API
 * Discord Web browser is managed externally (by OpenClaw or manually)
 */
export async function startBrowserMode(): Promise<void> {
  const apiPort = parseInt(process.env.API_PORT ?? '8788', 10);

  // Audio device configuration
  const inputDevice = process.env.AUDIO_INPUT_DEVICE ?? 'BlackHole 16ch';
  const outputDevice = process.env.AUDIO_OUTPUT_DEVICE ?? 'BlackHole 2ch';
  const systemDevice = process.env.AUDIO_SYSTEM_DEVICE ?? 'MacBook Air-Lautsprecher';

  // VAD configuration
  const chunkSeconds = parseFloat(process.env.LISTEN_CHUNK_SECONDS ?? '3');
  const volumeThresholdDb = parseFloat(process.env.VAD_VOLUME_THRESHOLD ?? '-50');
  const silenceDurationMs = parseInt(process.env.VAD_SILENCE_DURATION ?? '1500', 10);
  const minSpeechDurationMs = parseInt(process.env.VAD_MIN_SPEECH_DURATION ?? '500', 10);
  const language = process.env.LANGUAGE ?? 'de';

  logger.info('Starting browser mode (audio-only)...');
  logger.info('Discord Web browser should be managed externally');

  // Initialize audio devices
  const audioDeviceConfig: AudioDevicesConfig = {
    inputDevice,
    outputDevice,
    systemDevice,
  };

  const audioDevices = new AudioDeviceManager(audioDeviceConfig);
  const devicesOk = await audioDevices.initialize();

  if (!devicesOk) {
    logger.error('Audio device initialization failed. Ensure BlackHole is installed.');
    logger.error('Install with: brew install blackhole-2ch blackhole-16ch');
    process.exit(1);
  }

  // Initialize providers
  const sttProvider = createSTTProviderFromEnv();
  const ttsProvider = createTTSProviderFromEnv();

  // Create call manager
  const callManager = new CallManager(sttProvider, ttsProvider, {
    inputDeviceIndex: audioDevices.getInputDeviceIndex(),
    outputDevice: audioDevices.getOutputDevice(),
    systemDevice: audioDevices.getSystemDevice(),
    chunkSeconds,
    volumeThresholdDb,
    silenceDurationMs,
    minSpeechDurationMs,
    language,
  });

  // OpenClaw bridge configuration
  const openclawBridgeUrl = process.env.OPENCLAW_BRIDGE_URL ?? 'http://127.0.0.1:8790/inbound';
  const openclawBridgeEnabled = process.env.OPENCLAW_BRIDGE_ENABLED !== 'false';

  if (openclawBridgeEnabled) {
    logger.info(`OpenClaw bridge enabled → ${openclawBridgeUrl}`);

    // Set response callback: transcriptions are sent to OpenClaw plugin
    // OpenClaw will respond via the channel's sendText → POST /speak
    callManager.on('transcription', async (text: string) => {
      try {
        const res = await fetch(openclawBridgeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          logger.error(`OpenClaw bridge error: ${res.status} ${res.statusText}`);
        } else {
          logger.info(`Dispatched to OpenClaw: "${text.substring(0, 60)}"`);
        }
      } catch (err) {
        logger.error(`OpenClaw bridge unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  // API server
  const apiServer = new ApiServer(callManager, { port: apiPort });
  await apiServer.start();

  logger.info(`Browser mode ready. API at http://localhost:${apiPort}`);
  logger.info('');
  logger.info('Setup instructions:');
  logger.info('1. Open Discord Web in a browser');
  logger.info(`2. Set Discord input device to: ${outputDevice}`);
  logger.info(`3. Set Discord output device to: ${inputDevice}`);
  logger.info('4. Join a voice call or DM call');
  logger.info(`5. POST http://localhost:${apiPort}/call/start to begin listening`);
  logger.info('');
  logger.info('API endpoints:');
  logger.info('  POST /call/start  — Start listening for voice');
  logger.info('  POST /hangup      — Stop listening');
  logger.info('  POST /speak       — Speak text via TTS (body: { text: string })');
  logger.info('  GET  /status      — Get current state');
  logger.info('  WS   /ws          — Real-time events');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down browser mode...`);
    await callManager.dispose();
    await apiServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
