# Discord Voice Bot

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2.svg)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A modular Discord voice bot that listens to voice channels, transcribes speech, generates responses using LLMs, and speaks back using text-to-speech. Built with TypeScript and a pluggable provider architecture.

## ✨ Features

- 🎤 **Voice Activity Detection** - Automatically detects when users speak
- 🗣️ **Speech-to-Text** - Transcribes speech using Whisper API or local Whisper
- 🧠 **LLM Integration** - Generates responses using OpenAI or Anthropic models
- 🔊 **Text-to-Speech** - Speaks responses using OpenAI TTS, Sherpa-ONNX, or ElevenLabs
- ⚡ **Wake Word Support** - Responds to trigger words like "Hey Bot"
- 🔌 **Pluggable Architecture** - Easy to add new STT, LLM, and TTS providers
- 🎚️ **Multiple Modes** - Normal, Silent (no sounds), and Free (no wake word) modes
- 💾 **Conversation Memory** - Maintains context across messages

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Discord Voice Bot                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  Discord │    │   STT    │    │   LLM    │    │   TTS    │  │
│  │  Voice   │───▶│ Provider │───▶│ Provider │───▶│ Provider │  │
│  │ Recorder │    │          │    │          │    │          │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│       │              │                │                │        │
│       │         ┌────┴────┐      ┌────┴────┐     ┌────┴────┐   │
│       │         │Whisper  │      │ OpenAI  │     │ OpenAI  │   │
│       │         │  API    │      │   GPT   │     │   TTS   │   │
│       │         ├─────────┤      ├─────────┤     ├─────────┤   │
│       │         │Whisper  │      │Anthropic│     │ Sherpa  │   │
│       │         │ Local   │      │ Claude  │     │  ONNX   │   │
│       │         └─────────┘      └─────────┘     ├─────────┤   │
│       │                                          │ElevenLabs│   │
│       ▼                                          └─────────┘   │
│  ┌──────────┐                                                   │
│  │  Voice   │◀──────────────────────────────────────────────── │
│  │  Player  │           Audio Response                         │
│  └──────────┘                                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 📋 Prerequisites

- **Node.js** 18.0.0 or higher
- **FFmpeg** installed and available in PATH
- **Discord Bot** with the following permissions:
  - Connect
  - Speak
  - Use Voice Activity
  - Read Messages/View Channels
  - Send Messages
  - Use Slash Commands

## 🚀 Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/schobiDotDev/discord-voice-bot.git
cd discord-voice-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
OPENAI_API_KEY=your_openai_key
```

### 4. Build and run

```bash
npm run build
npm start
```

Or for development:

```bash
npm run dev
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DISCORD_TOKEN` | Discord bot token | ✅ | - |
| `DISCORD_CLIENT_ID` | Discord application ID | ✅ | - |
| `DISCORD_GUILD_ID` | Guild ID for dev (faster command registration) | ❌ | - |
| `BOT_TRIGGERS` | Wake words (comma-separated) | ❌ | `hey bot,ok bot` |
| `STT_PROVIDER` | Speech-to-text provider | ❌ | `whisper-api` |
| `LLM_PROVIDER` | LLM provider | ❌ | `openai` |
| `TTS_PROVIDER` | Text-to-speech provider | ❌ | `openai` |

See `.env.example` for the complete list of options.

### Providers

#### Speech-to-Text (STT)

| Provider | Description | API Key Required |
|----------|-------------|------------------|
| `whisper-api` | OpenAI Whisper API | Yes (OpenAI) |
| `whisper-local` | Self-hosted whisper.cpp | No |

#### Language Models (LLM)

| Provider | Description | Models |
|----------|-------------|--------|
| `openai` | OpenAI GPT models | gpt-4, gpt-4-turbo, gpt-3.5-turbo |
| `anthropic` | Anthropic Claude | claude-3-opus, claude-3-sonnet |

#### Text-to-Speech (TTS)

| Provider | Description | Voices |
|----------|-------------|--------|
| `openai` | OpenAI TTS | alloy, echo, fable, onyx, nova, shimmer |
| `sherpa-onnx` | Local TTS (free) | Various ONNX models |
| `elevenlabs` | ElevenLabs | Custom voice cloning |

## 🎮 Commands

| Command | Description |
|---------|-------------|
| `/join` | Join your voice channel |
| `/join mode:silent` | Join without confirmation sounds |
| `/join mode:free` | Join without requiring wake words |
| `/leave` | Leave the voice channel |
| `/reset` | Reset your conversation history |
| `/status` | Show bot status and configuration |

## 📁 Project Structure

```
discord-voice-bot/
├── src/
│   ├── index.ts              # Entry point
│   ├── bot.ts                # Discord bot setup
│   ├── config.ts             # Configuration management
│   ├── commands/             # Slash commands
│   │   ├── index.ts          # Command registry
│   │   ├── join.ts
│   │   ├── leave.ts
│   │   ├── reset.ts
│   │   └── status.ts
│   ├── voice/                # Voice handling
│   │   ├── connection.ts     # Connection management
│   │   ├── recorder.ts       # Audio recording + VAD
│   │   └── player.ts         # Audio playback
│   ├── providers/            # Pluggable providers
│   │   ├── stt/              # Speech-to-text
│   │   ├── llm/              # Language models
│   │   └── tts/              # Text-to-speech
│   ├── services/             # Business logic
│   │   ├── conversation.ts   # Chat history
│   │   └── voice-assistant.ts
│   └── utils/
│       ├── logger.ts
│       └── audio.ts
├── sounds/                   # Sound effects
├── recordings/               # Temporary recordings
├── .env.example
├── package.json
└── tsconfig.json
```

## 🔊 Adding Sound Effects

Place MP3 files in the `sounds/` directory:

- `understood.mp3` - Played when trigger word detected
- `result.mp3` - Played before speaking response

## 🛠️ Development

```bash
# Run in development mode with hot reload
npm run dev

# Type check
npm run typecheck

# Lint
npm run lint

# Format code
npm run format
```

## 🐳 Docker (Optional)

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

CMD ["npm", "start"]
```

## ❓ FAQ

**Q: Why isn't the bot responding?**
A: Check that you're using the configured trigger words (default: "hey bot", "ok bot") or use `/join mode:free` for trigger-free mode.

**Q: Can I use multiple LLM providers at once?**
A: Currently only one provider is active at a time, configured via `LLM_PROVIDER`.

**Q: How do I reduce latency?**
A: Use local providers (whisper-local, sherpa-onnx) for STT/TTS, and consider using faster LLM models.

**Q: The bot keeps ignoring my commands?**
A: Check that `VAD_SILENCE_DURATION` isn't too short, and that your microphone is properly configured.

## 📜 License

MIT © Felix Schoberwalter

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
