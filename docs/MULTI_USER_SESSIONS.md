# Multi-User Sessions Feature

## Overview

The Multi-User Sessions feature enables the Discord Voice Bot to handle multiple users speaking simultaneously, with individual conversation contexts, response queuing, and intelligent interrupt handling.

## Architecture Changes

### 1. **User-Specific Conversation Contexts**

Each user now has their own conversation history managed by the `ConversationMemory` service:

- **Per-user message history** (up to 10 messages)
- **Automatic TTL-based cleanup** (30 minutes)
- **Context included in text bridge messages** for better AI responses

**Files:**
- `src/services/conversation-memory.ts` - Memory store implementation
- `src/services/conversation.ts` - Updated to use ConversationMemory
- `src/services/text-bridge.ts` - Updated to include conversation context

### 2. **Response Queue System**

The `ResponseQueue` manages multiple pending responses:

- **Priority-based queue** - Earlier requests get higher priority
- **User deduplication** - Latest request from a user replaces older ones
- **Interrupt handling** - New speech interrupts current playback

**Files:**
- `src/services/response-queue.ts` - Queue implementation

### 3. **Multi-User Voice Assistant**

The `VoiceAssistantMulti` replaces the single-user `VoiceAssistant`:

**Key Changes:**
- **User sessions** - Each user has their own processing state
- **Parallel processing** - Multiple users can be transcribed simultaneously
- **Smart interrupts** - User B speaking interrupts Bot responding to User A
- **Per-user conversation memory** - Context is maintained separately

**Files:**
- `src/services/voice-assistant-multi.ts` - New multi-user implementation
- `src/bot.ts` - Updated to use VoiceAssistantMulti
- `src/commands/*.ts` - Updated type references

## Audio Flow

### Current Architecture (unchanged)

Audio is already separated per user at the recording level:

```
Discord Voice → VoiceRecorder → Per-User Opus Streams → Per-User PCM Files
```

The `VoiceRecorder` class uses Discord's `receiver.subscribe(userId)` to get separate audio streams for each user.

### Processing Flow (Multi-User)

```
┌─────────────────────────────────────────────────────────────┐
│ Multiple Users Speaking Simultaneously                      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  VoiceRecorder (per-user)       │
        │  - User A: PCM stream           │
        │  - User B: PCM stream           │
        └─────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  Wake Word Detection (parallel)  │
        └─────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  STT Transcription (parallel)    │
        └─────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  ConversationService             │
        │  - User A context                │
        │  - User B context                │
        └─────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  Text Bridge → AI Response       │
        └─────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  ResponseQueue                   │
        │  - User A response pending       │
        │  - User B response pending       │
        └─────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  VoicePlayer (sequential)        │
        │  - Play User A response          │
        │  - Then User B response          │
        └─────────────────────────────────┘
```

## Interrupt Handling

### Scenario: User B interrupts while Bot is responding to User A

**Old Behavior:**
- User B's speech would be ignored (bot is processing)

**New Behavior:**
1. User B starts speaking
2. `handleRecording()` detects current response playback
3. Calls `responseQueue.cancelAll()`
4. VoicePlayer stops current playback
5. User B's request is processed
6. User A's response is removed from queue

## User Session Management

Each user in the voice channel has a session:

```typescript
interface UserSession {
  userId: string;
  username: string;
  isProcessing: boolean;  // Is this user currently being processed?
  lastActivity: number;   // Last interaction timestamp
}
```

**Session Lifecycle:**
- **Created** when user joins voice channel or first speaks
- **Updated** on each interaction
- **Destroyed** when user leaves voice channel

## Queue Priority

Currently implemented as FIFO (First In, First Out) with timestamp-based ordering:

```typescript
interface QueuedResponse {
  userId: string;
  username: string;
  text: string;
  timestamp: number;
  priority: number;  // Lower = higher priority (currently unused)
}
```

**Future Enhancement:** Could implement dynamic priority based on:
- Interrupt count
- User roles
- Request urgency

## Conversation Memory

### Structure

```typescript
interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
```

### Configuration

- **Max Messages:** 10 per user
- **TTL:** 30 minutes of inactivity
- **Cleanup:** Every 5 minutes

### Context Format

Sent to the AI via text bridge:

```
📝 **Conversation History:**
User: What's the weather?
Assistant: It's sunny and 72°F today.
User: Should I bring an umbrella?
```

## Migration Guide

### From VoiceAssistant to VoiceAssistantMulti

The API is mostly compatible:

**Method Changes:**
- ✅ `start()` - Same interface
- ✅ `stop()` - Same interface
- ✅ `handleUserJoin()` - Same interface
- ✅ `handleUserLeave()` - Same interface
- ✅ `getMode()` - Same interface
- ⚠️ `isProcessing()` - Removed (use `isUserProcessing(guildId, userId)`)
- ✅ `interrupt()` - Enhanced with optional userId parameter

**New Methods:**
- `isUserProcessing(guildId: string, userId: string): boolean`

### Breaking Changes

1. **Status Command:** No longer has single "isProcessing" state
   - Replaced with per-user status (future enhancement)

2. **Imports:** Update service imports
   ```typescript
   // Old
   import { VoiceAssistant } from './services/index.js';
   
   // New
   import { VoiceAssistantMulti } from './services/index.js';
   ```

## Testing

### Manual Test Scenarios

1. **Two users speak at same time**
   - Expected: Both are transcribed, responses queued

2. **User B interrupts User A's response**
   - Expected: User A's response stops, User B is processed

3. **User speaks while their request is processing**
   - Expected: Previous request cancelled, new one processed

4. **Conversation context persistence**
   - Expected: Bot remembers previous messages per user

### Load Testing

- **Multiple users (3-5)** speaking in quick succession
- **Rapid interrupts** - Users interrupting each other
- **Long conversations** - Context maintained over 10+ exchanges

## Future Enhancements

### Planned
- [ ] Dynamic priority based on user roles
- [ ] Per-user response interrupts (don't cancel all responses)
- [ ] Conversation analytics (who speaks most, avg response time)
- [ ] User preferences (TTS voice, response style)

### Considered
- [ ] Multiple simultaneous responses (different audio channels)
- [ ] Group conversation mode (users talk to each other via bot)
- [ ] Conversation summaries (persist beyond 30 min TTL)

## Performance Considerations

### Memory Usage
- **Per-user overhead:** ~10KB (conversation history)
- **Estimated max (100 users):** ~1MB
- **Auto cleanup:** Every 5 minutes

### Concurrency
- **STT transcription:** Parallel per user (API rate limits apply)
- **TTS synthesis:** Parallel generation, sequential playback
- **Voice playback:** Sequential (Discord limitation)

### Bottlenecks
1. **Text Bridge response time** - Depends on external AI bot
2. **TTS generation** - Can be slow for long responses
3. **Voice playback** - Single audio stream to Discord

## Debugging

### Enable Debug Logs

Set log level to `debug` in config:

```env
LOG_LEVEL=debug
```

### Key Log Points

- `Memory: added user/assistant message for user X` - Conversation saved
- `Response queued for user X` - Response added to queue
- `Dequeued response for user X` - Starting playback
- `User X interrupted response for user Y` - Interrupt detected
- `User X interrupted their own request` - Self-interrupt

### Common Issues

**Issue: Responses not playing**
- Check: Is queue stuck? Look for "Dequeued response" logs
- Fix: Verify `responseQueue.on('ready')` handler is registered

**Issue: Context not persisting**
- Check: TTL expired? (30 minutes)
- Fix: Increase TTL in `conversation-memory.ts`

**Issue: Multiple responses for same user**
- Check: Queue deduplication working?
- Fix: Verify `enqueue()` removes existing user responses

## Related Files

### Core Services
- `src/services/voice-assistant-multi.ts` - Main orchestrator
- `src/services/conversation-memory.ts` - Per-user history
- `src/services/response-queue.ts` - Response queuing
- `src/services/conversation.ts` - Updated with memory
- `src/services/text-bridge.ts` - Updated with context

### Voice Components (unchanged)
- `src/voice/recorder.ts` - Already per-user
- `src/voice/player.ts` - Sequential playback
- `src/voice/connection.ts` - Guild management

### Bot Integration
- `src/bot.ts` - Uses VoiceAssistantMulti
- `src/commands/*.ts` - Updated type references

## License

Same as parent project.
