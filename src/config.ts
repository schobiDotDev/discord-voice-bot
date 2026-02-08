import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

dotenvConfig();

const configSchema = z.object({
  // Discord
  discord: z.object({
    token: z.string().min(1, 'DISCORD_TOKEN is required'),
    clientId: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
    guildId: z.string().optional(),
  }),

  // Bot behavior
  bot: z.object({
    triggers: z.array(z.string()).default(['hey bot', 'ok bot']),
    playSounds: z.boolean().default(true),
  }),

  // User access control
  access: z.object({
    ownerOnly: z.boolean().default(false),
    ownerId: z.string().optional(),
    allowedUsers: z.array(z.string()).default([]),
    blockedUsers: z.array(z.string()).default([]),
  }),

  // Text Bridge (for external bot integration)
  textBridge: z.object({
    channelId: z.string().optional(),
    responderBotId: z.string().optional(),
    responseTimeout: z.number().int().positive().default(30000),
  }),

  // OpenClaw bridge (optional — when set, transcriptions route to OpenClaw)
  openclawBridge: z.object({
    url: z.string().url().optional(),
  }).default({}),

  // DM-Call service (standalone process for Discord DM voice calls via CDP)
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

  // STT
  stt: z.object({
    provider: z.enum(['whisper-api', 'whisper-local']).default('whisper-api'),
    apiUrl: z.string().url(),
    apiKey: z.string().optional(),
    model: z.string().default('whisper-1'),
  }),

  // TTS
  tts: z.object({
    provider: z.enum(['openai', 'sherpa-onnx', 'elevenlabs']).default('openai'),
    apiUrl: z.string().url(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    voice: z.string().default('nova'),
  }),

  // Wake Word Detection
  wakeWord: z.object({
    provider: z.enum(['none', 'openwakeword']).default('none'),
    modelPath: z.string().default('./models/openwakeword'),
    keywords: z.array(z.string()).default(['hey_jarvis']),
    sensitivity: z.number().min(0).max(1).default(0.5),
  }),

  // VAD
  vad: z.object({
    silenceDuration: z.number().int().positive().default(1500),
    minSpeechDuration: z.number().int().positive().default(500),
    volumeThreshold: z.number().default(-50), // dB, below this is silence
  }),

  // Audio
  audio: z.object({
    sampleRate: z.number().int().positive().default(48000),
    channels: z.literal(1).or(z.literal(2)).default(1),
    chunkSeconds: z.number().positive().default(3), // Recording chunk duration
  }),

  // Browser mode audio devices (macOS BlackHole)
  browserAudio: z.object({
    inputDevice: z.string().default('BlackHole 16ch'), // Record from (Discord speaker output)
    outputDevice: z.string().default('BlackHole 2ch'), // Play TTS to (Discord mic input)
    systemDevice: z.string().default('MacBook Air-Lautsprecher'), // Restore system output
  }),

  // API server (browser mode)
  api: z.object({
    port: z.number().int().positive().default(8788),
  }),

  // Language
  language: z.string().default('de'),

  // Logging
  logLevel: z.number().int().min(1).max(3).default(2),
});

export type Config = z.infer<typeof configSchema>;

function parseConfig(): Config {
  const triggers = process.env.BOT_TRIGGERS?.split(',').map((t) => t.trim().toLowerCase()) ?? [
    'hey bot',
    'ok bot',
  ];

  const rawConfig = {
    discord: {
      token: process.env.DISCORD_TOKEN ?? '',
      clientId: process.env.DISCORD_CLIENT_ID ?? '',
      guildId: process.env.DISCORD_GUILD_ID,
    },
    bot: {
      triggers,
      playSounds: process.env.PLAY_SOUNDS !== 'false',
    },
    access: {
      ownerOnly: process.env.OWNER_ONLY === 'true',
      ownerId: process.env.OWNER_ID,
      allowedUsers:
        process.env.ALLOWED_USERS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      blockedUsers:
        process.env.BLOCKED_USERS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
    },
    textBridge: {
      channelId: process.env.TEXT_CHANNEL_ID || undefined,
      responderBotId: process.env.RESPONDER_BOT_ID || undefined,
      responseTimeout: parseInt(process.env.RESPONSE_TIMEOUT ?? '30000', 10),
    },
    openclawBridge: {
      url: process.env.OPENCLAW_BRIDGE_URL || undefined,
    },
    dmCall: {
      port: parseInt(process.env.DM_CALL_PORT ?? '8792', 10),
      cdpUrl: process.env.CDP_URL ?? 'ws://localhost:9222',
      blackholeInput: process.env.BLACKHOLE_INPUT ?? process.env.AUDIO_OUTPUT_DEVICE ?? 'BlackHole 2ch',
      blackholeOutput: process.env.BLACKHOLE_OUTPUT ?? process.env.AUDIO_INPUT_DEVICE ?? 'BlackHole 16ch',
      systemAudioDevice: process.env.AUDIO_SYSTEM_DEVICE ?? 'MacBook Air-Lautsprecher',
      timeout: parseInt(process.env.DM_CALL_TIMEOUT ?? '60', 10),
      silenceTimeout: parseFloat(process.env.DM_CALL_SILENCE ?? '1.5'),
      connectTimeout: parseInt(process.env.DM_CALL_CONNECT_TIMEOUT ?? '20000', 10),
    },
    stt: {
      provider: process.env.STT_PROVIDER ?? 'whisper-api',
      apiUrl: process.env.STT_API_URL ?? 'https://api.openai.com/v1/audio/transcriptions',
      apiKey: process.env.STT_API_KEY,
      model: process.env.STT_MODEL ?? 'whisper-1',
    },
    wakeWord: {
      provider: process.env.WAKEWORD_PROVIDER ?? 'none',
      modelPath: process.env.WAKEWORD_MODEL_PATH ?? './models/openwakeword',
      keywords:
        process.env.WAKEWORD_KEYWORDS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? ['hey_jarvis'],
      sensitivity: parseFloat(process.env.WAKEWORD_SENSITIVITY ?? '0.5'),
    },
    tts: {
      provider: process.env.TTS_PROVIDER ?? 'openai',
      apiUrl: process.env.TTS_API_URL ?? 'https://api.openai.com/v1/audio/speech',
      apiKey: process.env.TTS_API_KEY,
      model: process.env.TTS_MODEL,
      voice: process.env.TTS_VOICE ?? 'nova',
    },
    vad: {
      silenceDuration: parseInt(process.env.VAD_SILENCE_DURATION ?? '1500', 10),
      minSpeechDuration: parseInt(process.env.VAD_MIN_SPEECH_DURATION ?? '500', 10),
      volumeThreshold: parseFloat(process.env.VAD_VOLUME_THRESHOLD ?? '-50'),
    },
    audio: {
      sampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE ?? '48000', 10),
      channels: parseInt(process.env.AUDIO_CHANNELS ?? '1', 10),
      chunkSeconds: parseFloat(process.env.LISTEN_CHUNK_SECONDS ?? '3'),
    },
    browserAudio: {
      inputDevice: process.env.AUDIO_INPUT_DEVICE ?? 'BlackHole 16ch',
      outputDevice: process.env.AUDIO_OUTPUT_DEVICE ?? 'BlackHole 2ch',
      systemDevice: process.env.AUDIO_SYSTEM_DEVICE ?? 'MacBook Air-Lautsprecher',
    },
    api: {
      port: parseInt(process.env.API_PORT ?? '8788', 10),
    },
    language: process.env.LANGUAGE ?? 'de',
    logLevel: parseInt(process.env.LOG_LEVEL ?? '2', 10),
  };

  return configSchema.parse(rawConfig);
}

export const config = parseConfig();

/**
 * Check if a user is allowed to use the voice bot
 */
export function isUserAllowed(userId: string, guildOwnerId?: string): boolean {
  const { ownerId, ownerOnly, allowedUsers, blockedUsers } = config.access;

  // Check blocklist first
  if (blockedUsers.includes(userId)) {
    return false;
  }

  // Owner-only mode
  if (ownerOnly) {
    const effectiveOwnerId = ownerId ?? guildOwnerId;
    return effectiveOwnerId === userId;
  }

  // If allowlist is set, user must be on it
  if (allowedUsers.length > 0) {
    return allowedUsers.includes(userId);
  }

  // Default: allow all (not blocked)
  return true;
}
