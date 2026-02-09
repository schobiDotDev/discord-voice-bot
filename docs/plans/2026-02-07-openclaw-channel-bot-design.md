# Discord Voice Bot - OpenClaw Channel Integration

## Overview

Transform the Discord Voice Bot into an OpenClaw channel service. The bot joins
Discord voice channels, transcribes speech from allowed users, routes
transcriptions to an OpenClaw agent session, and plays back agent responses as
TTS audio in the channel.

## Architecture

```
Discord Voice Channel
        | (Opus Audio)
        v
Discord Bot (standalone Node.js process)
        |
        |-- POST /inbound --> OpenClaw Plugin (discord-voice)
        |                           |
        |                           v
        |                     OpenClaw Agent Session
        |                     (discord-voice:group:{channelId})
        |                           |
        |   <-- sendText() ---------+
        |
        |-- POST text log --------> Discord Text Channel
        v                           (persistent transcript)
TTS Playback in Voice Channel
```

Two independent processes connected via HTTP:

- **Discord Bot** - Standalone Node.js. Handles voice, STT, TTS, audio.
- **OpenClaw Plugin** - Runs inside OpenClaw. Receives transcriptions, routes to
  agent session, delivers responses back to the bot.

## Inbound Path (User speaks -> Agent thinks)

1. User speaks in voice channel
2. Bot records audio (only from allowed users via existing access control)
3. Mode determines activation:
   - `/join free` - transcribe everything
   - `/join` - only on wake word / trigger word
4. STT provider transcribes audio to text
5. Bot sends transcription to **two destinations in parallel**:
   - `POST {OPENCLAW_BRIDGE_URL}/inbound` with payload:
     ```json
     {
       "text": "Wie ist das Wetter morgen?",
       "userId": "123456789",
       "userName": "Felix",
       "channelId": "987654321",
       "guildId": "111222333"
     }
     ```
   - Discord text channel (existing TextBridge) as persistent log:
     `"Felix: Wie ist das Wetter morgen?"`
6. OpenClaw Plugin receives, routes to session `discord-voice:group:{channelId}`
7. Agent processes with full session context and generates response

## Outbound Path (Agent responds -> User hears)

1. Agent response goes through channel's `sendText()` callback
2. Plugin cleans markdown/formatting from text
3. Plugin sends `POST {voiceBotUrl}/speak` with `{ "text": "..." }`
4. Bot synthesizes TTS audio and plays it in voice channel
5. Agent response is also logged to the Discord text channel

## Session Model

- **One session per voice channel** (shared, not per-user)
- Session key: `agent:main:discord-voice:group:{channelId}`
- All allowed users speak into the same session
- Transcriptions include username for context so the agent knows who is speaking
- Session persists in OpenClaw regardless of bot state (join/leave/crash)

## Text Channel Logging

Transcriptions and responses are logged to a Discord text channel as a
persistent record. This provides:

- Visible history of what was spoken and what the agent answered
- Debugging aid
- Ability to scroll back through conversations

The text channel log runs **in parallel** to the OpenClaw bridge - it is not
part of the processing pipeline. The TextBridge's "wait for responder" logic
is not used; it only logs.

## Changes Required

### Bot Side

#### VoiceAssistant - Add OpenClaw Bridge Mode

The `VoiceAssistant` currently uses `TextBridgeService` to send transcriptions
to a text channel and wait for a responder bot. A new mode sends transcriptions
to the OpenClaw bridge instead:

- New config: `OPENCLAW_BRIDGE_URL` (e.g. `http://localhost:8790/inbound`)
- When set, transcriptions go to OpenClaw via HTTP POST
- TextBridge still logs transcriptions to text channel (fire-and-forget, no waiting)
- Responses arrive asynchronously via `POST /speak` on the API server
- No changes to recording, STT, TTS, or audio playback pipeline

#### API Server - Accept Speak Requests

Already implemented: `POST /speak` endpoint on the API server accepts
`{ text }` and plays TTS. This endpoint needs to work in bot mode too
(currently only browser mode starts the API server).

- Start API server in bot mode when `OPENCLAW_BRIDGE_URL` is configured
- Route `/speak` to the correct guild's voice player

### OpenClaw Plugin Side

#### Add HTTP Server for Inbound

The plugin needs to accept `POST /inbound` from the voice bot:

- Start HTTP server on configured port (default 8790)
- Parse transcription payload (text, userId, userName, channelId, guildId)
- Format message with username: `"Felix: Wie ist das Wetter morgen?"`
- Route to agent session using channel+scope+identifier

#### Session Routing

- Determine session key from `channelId`: `discord-voice:group:{channelId}`
- Create session on first message if it doesn't exist
- Feed formatted transcription into the session

### No Changes Required

- STT providers (Whisper API/Local) - unchanged
- TTS providers (OpenAI/SherpaOnnx/ElevenLabs) - unchanged
- Voice recording pipeline - unchanged
- Wake word / trigger word detection - unchanged
- Access control (ALLOWED_USERS, BLOCKED_USERS, OWNER_ONLY) - unchanged
- Slash commands (/join, /join free, /leave) - unchanged

## Configuration

### Bot Side (.env)

```env
# Existing
MODE=bot
DISCORD_TOKEN=...
TEXT_CHANNEL_ID=...        # For persistent transcript logging

# New
OPENCLAW_BRIDGE_URL=http://localhost:8790/inbound
API_PORT=8788              # Already exists, now also used in bot mode
```

### OpenClaw Plugin Side (openclaw plugin config)

```json
{
  "voiceBotUrl": "http://localhost:8788",
  "inboundPort": 8790
}
```

## Sequence Diagram

```
User        Bot              OpenClaw Plugin      Agent
 |           |                    |                  |
 |--speak--->|                    |                  |
 |           |--STT------------->|                  |
 |           |--log to text ch   |                  |
 |           |--POST /inbound--->|                  |
 |           |                   |--route to------->|
 |           |                   |   session        |
 |           |                   |                  |--think
 |           |                   |<--sendText()-----|
 |           |<--POST /speak-----|                  |
 |           |--log to text ch   |                  |
 |<--TTS-----|                    |                  |
```

## Future Extensions (Out of Scope)

- DM call feature (OpenClaw calls user via real Discord account)
- Turn detection for real-time conversation
- Multi-guild support with per-guild sessions
- API for dynamic channel join/leave
