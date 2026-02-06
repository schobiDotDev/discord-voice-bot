# Discord Voice Bot

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2.svg)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Discord voice-to-text bridge that listens to voice channels, transcribes speech, and forwards it to a text channel for external bots to respond. Responses are then spoken back via text-to-speech.

Built for integration with external conversational bots (like [OpenClaw](https://github.com/openclaw/openclaw)) that handle the actual conversation logic.

## ✨ Features

- 🎤 **Voice Activity Detection** - Automatically detects when users speak
- 🗣️ **Speech-to-Text** - Transcribes speech using Whisper API or local Whisper
- 🔗 **Text Bridge** - Posts transcriptions to a text channel for external bots
- 🔊 **Text-to-Speech** - Speaks responses using OpenAI TTS, Sherpa-ONNX, or ElevenLabs
- ⚡ **Wake Word Support** - Responds to trigger words like "Hey Bot"
- 👥 **User Metadata** - Includes username, user ID, and speech duration in transcriptions
- 🔒 **Access Control** - Owner-only mode, allowlist, and blocklist support
- 🔌 **Pluggable Architecture** - Easy to add new STT and TTS providers
- 🎚️ **Multiple Modes** - Normal, Silent (no sounds), and Free (no wake word) modes

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Discord Server                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐                         ┌─────────────┐                   │
│   │ Voice Bot   │                         │ Responder   │                   │
│   │ (this bot)  │                         │ Bot         │                   │
│   └──────┬──────┘                         └──────┬──────┘                   │
│          │                                       │                          │
│   ┌──────┴──────────────────────────────────────┴──────┐                   │
│   │                Voice Channel                       │                    │
│   │                                                    │                    │
│   │  🎤 User speaks ──────────────────────────────┐    │                   │
│   │                                               │    │                    │
│   │                                               ▼    │                    │
│   │  ┌──────────┐    ┌──────────┐                     │                    │
│   │  │  Voice   │───▶│   STT    │                     │                    │
│   │  │ Recorder │    │(Whisper) │                     │                    │
│   │  └──────────┘    └────┬─────┘                     │                    │
│   │                       │                            │                    │
│   └───────────────────────┼────────────────────────────┘                   │
│                           │                                                 │
│                           ▼                                                 │
│   ┌─────────────────────────────────────────────────────────────────┐      │
│   │                     Text Channel (#voice-chat)                   │      │
│   │                                                                  │      │
│   │  🎤 **Username** (ID: 123456789) | Dauer: 3.2s                  │      │
│   │  > What's the weather?                                          │      │
│   │                                       ──────────────────────┐    │      │
│   │                                                             │    │      │
│   │                                                             ▼    │      │
│   │  @User: "It's sunny and 22°C today!"  ◀──── Responder Bot       │      │
│   │                                                                  │      │
│   └────────────────────────────┬────────────────────────────────────┘      │
│                                │                                            │
│                                ▼                                            │
│   ┌────────────────────────────────────────────────────────────────┐       │
│   │                      Voice Channel                              │       │
│   │                                                                 │       │
│   │  ┌──────────┐    ┌──────────┐                                  │       │
│   │  │   TTS    │───▶│  Voice   │───▶ 🔊 User hears response       │       │
│   │  │ (OpenAI) │    │  Player  │                                  │       │
│   │  └──────────┘    └──────────┘                                  │       │
│   │                                                                 │       │
│   └─────────────────────────────────────────────────────────────────┘       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Message Format

When a user speaks, the bot posts a transcription with metadata:

```
🎤 **Username** (ID: 123456789) | Dauer: 3.2s
> What's the weather like today?
```

This allows the responder bot (e.g., OpenClaw) to:
- Know WHO is speaking (for user context/sessions)
- See the user's Discord ID (for permissions/identification)
- Know how long they spoke (for context)

### Flow

1. **User speaks** in the voice channel
2. **Voice Bot** records and transcribes the audio using STT
3. **Voice Bot** posts the transcription with user metadata to the configured text channel
4. **Responder Bot** (e.g., OpenClaw) reads the message and replies
5. **Voice Bot** detects the response and speaks it via TTS

## 📋 Prerequisites

- **Node.js** 18.0.0 or higher
- **FFmpeg** installed and available in PATH
- **Two Discord Bots**:
  - **Voice Bot** (this bot) - Handles voice recording and playback
  - **Responder Bot** - Provides text responses (e.g., OpenClaw)

### Required Permissions

**Voice Bot:**
- Connect
- Speak
- Use Voice Activity
- Read Messages/View Channels
- Send Messages
- Use Slash Commands

**Responder Bot:**
- Read Messages/View Channels
- Send Messages

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

### 3. Set up Discord

1. Create a Discord bot at <https://discord.com/developers/applications>
2. Get the bot token and application ID
3. Create a text channel for the voice bridge (e.g., `#voice-chat`)
4. Invite both bots to your server with appropriate permissions
5. Get the **User ID** (not Application ID) of your responder bot

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your_voice_bot_token
DISCORD_CLIENT_ID=your_voice_bot_application_id

# Text Bridge
TEXT_CHANNEL_ID=your_text_channel_id
RESPONDER_BOT_ID=your_responder_bot_user_id

# STT
STT_API_KEY=your_openai_key

# TTS
TTS_API_KEY=your_openai_key
```

### 5. Build and run

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
| `TEXT_CHANNEL_ID` | Text channel for voice transcriptions | ✅ | - |
| `RESPONDER_BOT_ID` | User ID of the responder bot | ✅ | - |
| `RESPONSE_TIMEOUT` | Response timeout in ms | ❌ | `30000` |
| `BOT_TRIGGERS` | Wake words (comma-separated) | ❌ | `hey bot,ok bot` |
| `STT_PROVIDER` | Speech-to-text provider | ❌ | `whisper-api` |
| `TTS_PROVIDER` | Text-to-speech provider | ❌ | `openai` |

#### Access Control Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OWNER_ID` | Your Discord user ID (for owner-only mode) | - |
| `OWNER_ONLY` | Only allow the owner to use voice features | `false` |
| `ALLOWED_USERS` | Comma-separated list of allowed user IDs | - |
| `BLOCKED_USERS` | Comma-separated list of blocked user IDs | - |

See `.env.example` for the complete list of options.

### 🔒 Access Control

The bot supports flexible access control to limit who can use voice features.

#### Owner-Only Mode

Restrict voice features to a single user:

```env
OWNER_ID=123456789012345678
OWNER_ONLY=true
```

If `OWNER_ID` is not set but `OWNER_ONLY=true`, it falls back to the Discord server owner.

#### Allowlist Mode

Only allow specific users:

```env
ALLOWED_USERS=123456789,987654321,555555555
```

When set, **only** these users can use voice features. Everyone else is ignored.

#### Blocklist Mode

Block specific users:

```env
BLOCKED_USERS=111111111,222222222
```

These users are always blocked, even if they're on the allowlist.

#### Priority Order

1. **Blocklist** - Always checked first. Blocked users are rejected.
2. **Owner-Only** - If enabled, only the owner can use the bot.
3. **Allowlist** - If set, user must be on the list.
4. **Default** - If none of the above, everyone is allowed.

### Providers

#### Speech-to-Text (STT)

| Provider | Description | API Key Required |
|----------|-------------|------------------|
| `whisper-api` | OpenAI Whisper API | Yes (OpenAI) |
| `whisper-local` | Self-hosted whisper.cpp | No |

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
| `/reset` | Cancel any pending voice request |
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
│   │   └── tts/              # Text-to-speech
│   ├── services/             # Business logic
│   │   ├── text-bridge.ts    # Discord text channel bridge
│   │   ├── conversation.ts   # Conversation management
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
A: Check that (1) you're using the configured trigger words (default: "hey bot", "ok bot") or use `/join mode:free`, (2) the responder bot is in the same text channel, (3) `RESPONDER_BOT_ID` is correct, and (4) you're not blocked by access control settings.

**Q: How do I find the responder bot's User ID?**
A: Enable Developer Mode in Discord Settings → Advanced, then right-click the bot and select "Copy User ID".

**Q: How do I find my own User ID (for OWNER_ID)?**
A: Same as above - enable Developer Mode, right-click your own name, and select "Copy User ID".

**Q: Can I use any bot as the responder?**
A: Yes! Any bot that reads and responds to messages in the configured text channel will work. The Voice Bot simply waits for messages from the specified `RESPONDER_BOT_ID`.

**Q: How do I reduce latency?**
A: Use local providers (whisper-local, sherpa-onnx) for STT/TTS.

**Q: The bot keeps ignoring my commands?**
A: Check that `VAD_SILENCE_DURATION` isn't too short, that your microphone is properly configured, and that you're not blocked by access control.

## 📜 License

MIT © Felix Schoberwalter

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
