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
    textChatEnabled: z.boolean().default(true),
  }),

  // STT
  stt: z.object({
    provider: z.enum(['whisper-api', 'whisper-local']).default('whisper-api'),
    apiUrl: z.string().url(),
    apiKey: z.string().optional(),
    model: z.string().default('whisper-1'),
  }),

  // LLM
  llm: z.object({
    provider: z.enum(['openai', 'anthropic']).default('openai'),
    openai: z
      .object({
        apiKey: z.string().optional(),
        model: z.string().default('gpt-4-turbo-preview'),
        apiUrl: z.string().url().default('https://api.openai.com/v1'),
      })
      .optional(),
    anthropic: z
      .object({
        apiKey: z.string().optional(),
        model: z.string().default('claude-3-opus-20240229'),
      })
      .optional(),
    systemPrompt: z.string().default(
      'You are a helpful voice assistant. Keep responses concise and conversational. Avoid using markdown formatting as your responses will be spoken aloud.'
    ),
    systemPromptFree: z.string().default(
      'You are a helpful voice assistant in an ongoing conversation. Keep responses concise. Avoid markdown formatting.'
    ),
    memorySize: z.number().int().positive().default(20),
  }),

  // TTS
  tts: z.object({
    provider: z.enum(['openai', 'sherpa-onnx', 'elevenlabs']).default('openai'),
    apiUrl: z.string().url(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    voice: z.string().default('nova'),
  }),

  // VAD
  vad: z.object({
    silenceDuration: z.number().int().positive().default(1500),
    minSpeechDuration: z.number().int().positive().default(500),
  }),

  // Audio
  audio: z.object({
    sampleRate: z.number().int().positive().default(48000),
    channels: z.literal(1).or(z.literal(2)).default(1),
  }),

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
      textChatEnabled: process.env.TEXT_CHAT_ENABLED !== 'false',
    },
    stt: {
      provider: process.env.STT_PROVIDER ?? 'whisper-api',
      apiUrl: process.env.STT_API_URL ?? 'https://api.openai.com/v1/audio/transcriptions',
      apiKey: process.env.STT_API_KEY,
      model: process.env.STT_MODEL ?? 'whisper-1',
    },
    llm: {
      provider: process.env.LLM_PROVIDER ?? 'openai',
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL ?? 'gpt-4-turbo-preview',
        apiUrl: process.env.OPENAI_API_URL ?? 'https://api.openai.com/v1',
      },
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL ?? 'claude-3-opus-20240229',
      },
      systemPrompt:
        process.env.LLM_SYSTEM_PROMPT ??
        'You are a helpful voice assistant. Keep responses concise and conversational.',
      systemPromptFree:
        process.env.LLM_SYSTEM_PROMPT_FREE ??
        'You are a helpful voice assistant in an ongoing conversation. Keep responses concise.',
      memorySize: parseInt(process.env.MEMORY_SIZE ?? '20', 10),
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
    },
    audio: {
      sampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE ?? '48000', 10),
      channels: parseInt(process.env.AUDIO_CHANNELS ?? '1', 10),
    },
    logLevel: parseInt(process.env.LOG_LEVEL ?? '2', 10),
  };

  return configSchema.parse(rawConfig);
}

export const config = parseConfig();
