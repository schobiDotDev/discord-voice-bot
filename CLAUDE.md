# CLAUDE.md — discord-voice-bot

## Overview

A modular Discord voice bot that listens in voice channels, transcribes speech (STT), forwards to a text channel or OpenClaw for AI responses, and speaks back (TTS). Two modes: **bot mode** (Discord.js, joins voice channels) and **browser mode** (Puppeteer, handles DM voice calls via CDP).

**Author:** Felix Schoberwalter · **License:** MIT

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode (tsx)
npm start            # Run compiled bot (dist/index.js)
npm run dm-call      # Run DM call mode (browser-based)
npm run dm-call:dev  # DM call mode with watch
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run format       # Prettier
```

**Docker:** `docker build -t discord-voice-bot .`

## Architecture

```
src/
├── index.ts                   # Entry point — picks bot vs browser mode (MODE env)
├── bot.ts                     # Discord.js Bot class (slash commands, voice management)
├── config.ts                  # Zod-validated config from env vars
├── dm-call-main.ts            # Standalone DM call entry point
├── commands/                  # Slash commands (/join, /leave, /reset, /status)
├── modes/
│   └── browser/               # Puppeteer-based browser mode for DM voice calls
│       ├── entry.ts           # Browser mode bootstrap
│       ├── call-manager.ts    # Manages active DM calls
│       ├── conversation.ts    # Conversation flow logic
│       ├── recorder.ts        # Audio recording via BlackHole
│       ├── speaker.ts         # TTS playback via BlackHole
│       └── audio-devices.ts   # macOS audio device management
├── providers/
│   ├── stt/                   # Speech-to-Text providers
│   │   ├── whisper-api.ts     # OpenAI Whisper API
│   │   └── whisper-local.ts   # Local Whisper binary
│   ├── tts/                   # Text-to-Speech providers
│   │   ├── openai-tts.ts      # OpenAI TTS API
│   │   ├── sherpa-onnx.ts     # Local sherpa-onnx
│   │   └── elevenlabs.ts      # ElevenLabs API
│   └── wakeword/              # Wake word detection
│       └── openwakeword.ts    # OpenWakeWord integration
├── services/
│   ├── text-bridge.ts         # Posts transcriptions to text channel
│   ├── openclaw-bridge.ts     # Routes transcriptions to OpenClaw API
│   ├── conversation.ts        # Conversation state management
│   ├── conversation-memory.ts # Persistent conversation context
│   ├── voice-assistant.ts     # Single-user voice assistant
│   ├── voice-assistant-multi.ts # Multi-user voice assistant
│   ├── response-queue.ts      # Queued TTS response playback
│   ├── audio-bridge.ts        # Audio routing (BlackHole)
│   ├── discord-browser.ts     # Puppeteer Discord automation
│   ├── dm-call-service.ts     # DM call v1
│   ├── dm-call-service-v2.ts  # DM call v2 (improved)
│   ├── dm-call-api.ts         # HTTP API for DM call control
│   ├── bot-api-server.ts      # Bot HTTP API server
│   └── api-server.ts          # Browser mode API server
├── voice/
│   ├── connection.ts          # Discord voice connection management
│   ├── recorder.ts            # Audio stream recording
│   └── player.ts              # Audio playback to voice channel
└── utils/
    ├── audio.ts               # Audio format conversion (PCM, opus, wav)
    └── logger.ts              # Timestamped logging with levels
```

## Two Modes

| Mode | Entry | How it works |
|------|-------|-------------|
| **bot** (default) | `MODE=bot` | Discord.js bot joins voice channels via slash commands, records users, STT → text channel → waits for response → TTS |
| **browser** | `MODE=browser` | Puppeteer controls Discord in Chrome, handles DM voice calls via CDP + BlackHole audio routing (macOS) |

## Pluggable Providers

**STT:** `whisper-api` (OpenAI API), `whisper-local` (local binary)
**TTS:** `openai` (OpenAI), `sherpa-onnx` (local), `elevenlabs`
**Wake Word:** `none`, `openwakeword`

Set via env vars: `STT_PROVIDER`, `TTS_PROVIDER`, `WAKEWORD_PROVIDER`

## Key Environment Variables

```bash
# Required
DISCORD_TOKEN=          # Bot token
DISCORD_CLIENT_ID=      # Application client ID

# STT
STT_PROVIDER=whisper-api
STT_API_URL=https://api.openai.com/v1/audio/transcriptions
STT_API_KEY=sk-...

# TTS  
TTS_PROVIDER=openai
TTS_API_URL=https://api.openai.com/v1/audio/speech
TTS_API_KEY=sk-...
TTS_VOICE=nova

# Integration (pick one)
TEXT_CHANNEL_ID=        # Text bridge: post transcriptions here
OPENCLAW_BRIDGE_URL=    # Or route to OpenClaw API

# Browser mode (macOS + BlackHole required)
MODE=browser
CDP_URL=ws://localhost:9222
AUDIO_INPUT_DEVICE=BlackHole 16ch
AUDIO_OUTPUT_DEVICE=BlackHole 2ch

# Optional
DISCORD_GUILD_ID=       # Lock to specific guild
OWNER_ONLY=false
LANGUAGE=de
LOG_LEVEL=2             # 1=error, 2=info, 3=debug
```

Full config schema with defaults: see `src/config.ts`

## Code Style

- **TypeScript strict mode**, ESM (`"type": "module"`)
- **Zod** for config validation
- **Provider pattern** — all STT/TTS/WakeWord behind interfaces (`providers/*/interface.ts`)
- **Logging:** Custom logger with timestamps and levels (not console.log)
- **Error handling:** Global uncaughtException/unhandledRejection handlers

## Gotchas

1. **Browser mode requires macOS + BlackHole** — audio routing via virtual audio devices
2. **Two DM call service versions** — `dm-call-service.ts` (v1) and `dm-call-service-v2.ts` (v2) coexist
3. **No tests** — zero test coverage currently
4. **Bot mode needs DISCORD_TOKEN** — browser mode doesn't (uses Puppeteer + existing login)
5. **`voice-call-plugin/` and `openclaw-extension/`** exist at repo root — related but separate tools
6. **Sounds dir** — `sounds/` has audio files for join/leave/wake notifications
