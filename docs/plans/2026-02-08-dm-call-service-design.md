# DM-Call Service — OpenClaw Discord Voice Call Tool

## Overview

Eigenständiger HTTP-Service, der es OpenClaw ermöglicht, Discord-User über einen
echten Discord-Account (nicht Bot) per DM-Voice-Call anzurufen. OpenClaw sendet
einen HTTP-Request, der Service ruft den User an, spricht ein Greeting, nimmt
die Antwort auf, transkribiert sie und sendet das Ergebnis per Callback zurück.

## Architecture

```
OpenClaw Plugin                DM-Call Service              Browser (CDP)
     │                              │                           │
     ├── POST /call ──────────────→ │                           │
     │   { userId, message,         │── CDP: navigate to DM ──→│
     │     callbackUrl }            │── CDP: click Call ───────→│
     │                              │── BlackHole: speak TTS ──→│── Audio to User
     │←── 202 { callId } ──────────│                           │
     │                              │←─ BlackHole: record ─────│←─ User speaks
     │                              │── VAD: detect silence     │
     │                              │── CDP: hang up ──────────→│
     │                              │── STT: transcribe         │
     │←── POST callbackUrl ────────│                           │
     │   { callId, transcription }  │                           │
```

**Drei unabhängige Prozesse:**

- **Discord Bot** — Channel voice, STT, TTS (Bot-Token)
- **DM-Call Service** — DM voice calls via Browser (CDP + BlackHole)
- **OpenClaw Plugin** — Orchestriert beides, läuft in OpenClaw

## Design Decisions

| Entscheidung | Gewählt | Alternativen |
|---|---|---|
| Call-Auslösung | HTTP API Endpoint (`POST /call`) | WebSocket, Message Queue |
| Browser-Anbindung | Konfigurierbarer CDP URL | Managed Browser, Hardcoded |
| Audio-Routing | BlackHole Virtual Audio | Tab Audio Capture, WebRTC Interception |
| Pause-Erkennung | VAD-basiert (+ Safety-Timeout) | Fester Timeout, Nur Max-Dauer |
| Service-Architektur | Eigenständiger Prozess | In BotApiServer integriert |
| API-Modell | Asynchron mit Callback | Synchron, Polling |

## API Contract

### `POST /call`

Startet einen DM-Voice-Call.

```json
// Request
{
  "userId": "123456789",
  "message": "Hey, kurze Frage...",
  "callbackUrl": "http://127.0.0.1:8790/inbound",
  "channelId": "dm-call"
}

// Response: 202 Accepted
{
  "callId": "call_abc123",
  "status": "calling"
}

// Error: 409 Conflict (bereits ein Call aktiv)
{
  "error": "A call is already in progress",
  "activeCallId": "call_xyz789"
}
```

### `POST callbackUrl` (nach Call-Ende)

```json
{
  "callId": "call_abc123",
  "status": "completed",
  "transcription": "Ja klar, bin in 5 Minuten da",
  "duration": 12.4,
  "userId": "123456789",
  "channel": "discord-voice",
  "channelId": "dm-call"
}
```

Status-Werte: `completed` | `no_answer` | `failed`

### `GET /call/:callId`

Status eines laufenden oder abgeschlossenen Calls.

### `GET /health`

Standard Health-Check.

## Call Flow

### Phase 1 — Verbindung aufbauen

1. Request kommt rein, `callId` generieren, `202` zurück
2. CDP: Navigiere zu `discord.com/channels/@me/{dmChannelId}`
3. CDP: Finde und klicke den Call-Button (Voice Call Icon)
4. Warte bis Call verbunden ist (DOM-Element prüfen)
5. Timeout: Wenn nach ~20s kein Connect → Callback mit `no_answer`

### Phase 2 — Greeting sprechen

6. TTS: `message` in Audio umwandeln
7. BlackHole 2ch: Audio abspielen → Discord Mic-Input
8. Warte bis TTS fertig

### Phase 3 — Aufnehmen & Stille erkennen

9. BlackHole 16ch: Aufnahme starten (Discord Audio-Output)
10. VAD: Kontinuierlich Speech Activity prüfen
11. Wenn Speech erkannt → Aufnahme läuft
12. Wenn Speech endet + ~1.5s Stille → Aufnahme stoppen
13. Safety-Timeout: Max 60s Gesamtaufnahme

### Phase 4 — Auflegen & Verarbeiten

14. CDP: Hang-up Button klicken
15. STT: Aufgenommenes Audio transkribieren
16. Callback: Transcription an `callbackUrl` senden
17. Cleanup: Temp-Audio-Dateien löschen

## State Management

Ein einziges `ActiveCall | null` — ein Call gleichzeitig (BlackHole-Constraint).

```typescript
interface ActiveCall {
  callId: string;
  userId: string;
  callbackUrl: string;
  channelId: string;
  status: 'connecting' | 'greeting' | 'recording' | 'transcribing';
  startedAt: Date;
}
```

## Components

### Neue Dateien

```
src/
  dm-call-main.ts              # Entrypoint (express server + startup)
  services/
    dm-call-service.ts          # Call-Orchestrierung (der eigentliche Flow)
    dm-call-api.ts              # Express Routes (/call, /health, /call/:id)
    discord-browser.ts          # CDP-Steuerung (navigate, click, hangup)
    audio-bridge.ts             # BlackHole Recording & Playback
```

### Wiederverwendet

- `providers/stt/` — Transkription nach Aufnahme
- `providers/tts/` — Greeting in Audio umwandeln
- `providers/wakeword/` — VAD für Stille-Erkennung
- `utils/logger.ts` — Logging
- `config.ts` — Erweitert um DM-Call Config

## Configuration

```env
# DM-Call Service
DM_CALL_PORT=8792              # API Port
CDP_URL=ws://localhost:9222    # Chrome DevTools Protocol Endpoint
BLACKHOLE_INPUT=BlackHole2ch   # Virtual Audio: Mic → Discord
BLACKHOLE_OUTPUT=BlackHole16ch # Virtual Audio: Discord → Recording
DM_CALL_TIMEOUT=60             # Max Call-Dauer in Sekunden
DM_CALL_SILENCE=1.5            # Sekunden Stille bis Hangup
```

## OpenClaw Plugin Integration

Neuer Channel-Typ `discord-dm-call` im Plugin:

```typescript
registerChannel({
  name: "discord-dm-call",
  sendText: async (text, context) => {
    await fetch(`${dmCallServiceUrl}/call`, {
      method: "POST",
      body: JSON.stringify({
        userId: context.userId,
        message: text,
        callbackUrl: `http://127.0.0.1:${inboundPort}/inbound`,
        channelId: "dm-call"
      })
    });
  }
});
```

Plugin Config erweitert um:
```json
{
  "dmCallServiceUrl": "http://localhost:8792"
}
```

## Error Scenarios

| Szenario | Handling |
|---|---|
| User antwortet nicht | 20s Connect-Timeout → Callback `no_answer` |
| Bereits ein Call aktiv | `409 Conflict` sofort zurück |
| CDP-Verbindung verloren | Callback `failed`, Call-State cleanup |
| STT schlägt fehl | Callback `failed` mit Error-Details |
| Callback-URL nicht erreichbar | Retry 1x, dann Log + Cleanup |
| Max-Aufnahmedauer erreicht | Hangup + Transcribe was da ist |

## Future Extensions (Out of Scope)

- Turn Detection für echte Multi-Turn Gespräche
- Parallele Calls (mehrere Browser-Instanzen)
- Antwort des Agents während des Calls sprechen (Live-Conversation)
- Anrufe von User → Bot (Incoming Calls)
