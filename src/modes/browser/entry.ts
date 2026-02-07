import { config as dotenvConfig } from 'dotenv';
import { BrowserManager } from './browser-manager.js';
import { DiscordWeb } from './discord-web.js';
import { AudioBridge } from './audio-bridge.js';
import { CallManager } from './call-manager.js';
import { ApiServer } from '../../services/api-server.js';
import { WhisperAPIProvider } from '../../providers/stt/whisper-api.js';
import { WhisperLocalProvider } from '../../providers/stt/whisper-local.js';
import { SherpaOnnxProvider } from '../../providers/tts/sherpa-onnx.js';
import { OpenAITTSProvider } from '../../providers/tts/openai-tts.js';
import { ElevenLabsProvider } from '../../providers/tts/elevenlabs.js';
import type { STTProvider } from '../../providers/stt/interface.js';
import type { TTSProvider } from '../../providers/tts/interface.js';

dotenvConfig();

// Minimal logger for browser mode (avoids importing shared config which requires DISCORD_TOKEN)
const LOG_LEVEL = parseInt(process.env.LOG_LEVEL ?? '2', 10);

const log = {
  error: (msg: string) => console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`),
  info: (msg: string) => {
    if (LOG_LEVEL >= 2) console.info(`[${new Date().toISOString()}] [INFO] ${msg}`);
  },
  debug: (msg: string) => {
    if (LOG_LEVEL >= 3) console.debug(`[${new Date().toISOString()}] [DEBUG] ${msg}`);
  },
};

/**
 * Create STT provider from env vars (avoids shared config dependency)
 */
function createSTTProviderFromEnv(): STTProvider {
  const provider = process.env.STT_PROVIDER ?? 'whisper-api';
  const apiUrl = process.env.STT_API_URL ?? 'https://api.openai.com/v1/audio/transcriptions';
  const apiKey = process.env.STT_API_KEY;
  const model = process.env.STT_MODEL ?? 'whisper-1';

  log.info(`STT provider: ${provider}`);

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

  log.info(`TTS provider: ${provider}`);

  switch (provider) {
    case 'openai':
      return new OpenAITTSProvider({ apiUrl, apiKey, model, voice });
    case 'sherpa-onnx':
      return new SherpaOnnxProvider({ apiUrl, apiKey, model, voice });
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
 * Launches Puppeteer, logs into Discord Web, and exposes a REST/WS API
 */
export async function startBrowserMode(): Promise<void> {
  const email = process.env.DISCORD_EMAIL;
  const password = process.env.DISCORD_PASSWORD;
  const targetUserId = process.env.DISCORD_TARGET_USER_ID ?? '';
  const apiPort = parseInt(process.env.API_PORT ?? '8788', 10);
  const blackholeDevice = process.env.BLACKHOLE_DEVICE ?? 'BlackHole 2ch';
  const headless = process.env.BROWSER_HEADLESS === 'true';

  if (!email || !password) {
    log.error('DISCORD_EMAIL and DISCORD_PASSWORD are required for browser mode');
    process.exit(1);
  }

  log.info('Starting browser mode...');

  // Initialize providers (directly from env, no shared config dependency)
  const sttProvider = createSTTProviderFromEnv();
  const ttsProvider = createTTSProviderFromEnv();

  // Launch browser
  const browserManager = new BrowserManager({
    profileDir: './browser-profile',
    blackholeDevice,
    headless,
  });

  const page = await browserManager.launch();

  // Discord Web automation
  const discordWeb = new DiscordWeb(page);

  // Login
  const loggedIn = await discordWeb.login(email, password);
  if (!loggedIn) {
    log.error('Discord login failed. Exiting.');
    await browserManager.close();
    process.exit(1);
  }

  // Audio bridge
  const audioBridge = new AudioBridge({
    blackholeDevice,
    ttsProvider,
  });
  await audioBridge.attach(page);

  // Call manager
  const callManager = new CallManager(discordWeb, audioBridge, sttProvider, {
    targetUserId,
  });

  // Start watching for incoming calls
  callManager.startIncomingCallWatch();

  // API server
  const apiServer = new ApiServer(callManager, { port: apiPort });
  await apiServer.start();

  log.info(`Browser mode ready. API at http://localhost:${apiPort}`);
  log.info(`Target user: ${targetUserId || '(none — use POST /call/:userId)'}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down browser mode...`);
    await callManager.dispose();
    await apiServer.stop();
    await browserManager.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
