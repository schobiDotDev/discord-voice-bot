/**
 * Voice Call Plugin for OpenClaw
 *
 * Multi-turn voice call channel that calls Discord users via DM.
 *
 * Outbound (agent → user):
 *   1. First sendText() for a userId → POST /call (starts call with greeting)
 *   2. Subsequent sendText() for same userId → POST /call/:callId/respond
 *
 * Inbound (user speaks → agent):
 *   1. DM-Call service transcribes speech → POST /inbound callback
 *   2. Plugin routes transcription to /hooks/wake with channel "voice-call"
 *   3. Agent processes and responds via sendText() → loops back to outbound
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

let api: OpenClawPluginApi;

/** Active calls: userId → callId */
const activeCalls = new Map<string, string>();

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cleanTextForSpeech(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`#]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/NO_REPLY/g, "")
    .trim();
}

const plugin = {
  id: "voice-call",
  name: "Voice Call",
  description:
    "Multi-turn voice call channel — calls Discord users via DM and maintains a conversation loop",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      dmCallServiceUrl: {
        type: "string" as const,
        default: "http://localhost:8792",
      },
      inboundPort: {
        type: "number" as const,
        default: 8791,
      },
      agentResponseTimeout: {
        type: "number" as const,
        default: 30000,
      },
      maxConversationTurns: {
        type: "number" as const,
        default: 10,
      },
      keepRecordings: {
        type: "boolean" as const,
        default: false,
      },
    },
  },
  register(pluginApi: OpenClawPluginApi) {
    api = pluginApi;

    const config =
      pluginApi.config?.plugins?.entries?.["voice-call"]?.config ?? {};
    const dmCallServiceUrl = (config as any).dmCallServiceUrl ?? "http://localhost:8792";
    const inboundPort = (config as any).inboundPort ?? 8791;
    const targetUserId = (config as any).userId as string | undefined;
    const targetDmChannelId = (config as any).dmChannelId as string | undefined;
    const agentResponseTimeout = (config as any).agentResponseTimeout ?? 30000;
    const maxConversationTurns = (config as any).maxConversationTurns ?? 10;
    const keepRecordings = (config as any).keepRecordings ?? false;

    if (!targetUserId || !targetDmChannelId) {
      console.error("[voice-call] userId and dmChannelId must be set in plugin config");
    }

    // ── Register Channel ──
    pluginApi.registerChannel({
      plugin: {
        id: "voice-call",
        meta: {
          id: "voice-call",
          label: "Voice Call",
          selectionLabel: "Discord DM Voice Call",
          docsPath: "/channels/voice-call",
          blurb: "Call Discord users via DM with multi-turn conversation.",
          aliases: ["call", "dm-call"],
        },
        capabilities: {
          chatTypes: ["direct"] as const,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: (_cfg: any, accountId?: string) => ({
            accountId: accountId ?? "default",
            enabled: true,
          }),
        },
        outbound: {
          deliveryMode: "direct" as const,
          sendText: async (opts: { text: string }) => {
            const cleanText = cleanTextForSpeech(opts.text);
            if (!cleanText) return { ok: true };

            if (!targetUserId || !targetDmChannelId) {
              console.error("[voice-call] Plugin not configured — set userId and dmChannelId");
              return { ok: false };
            }

            const existingCallId = activeCalls.get(targetUserId);

            try {
              if (existingCallId) {
                // Active call — send response
                const res = await fetch(
                  `${dmCallServiceUrl}/call/${existingCallId}/respond`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: cleanText }),
                  }
                );

                if (res.status === 409) {
                  // Not waiting for response yet — retry after brief delay
                  await new Promise((r) => setTimeout(r, 500));
                  const retry = await fetch(
                    `${dmCallServiceUrl}/call/${existingCallId}/respond`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ text: cleanText }),
                    }
                  );
                  return { ok: retry.ok };
                }

                return { ok: res.ok };
              } else {
                // No active call — start new one
                const res = await fetch(`${dmCallServiceUrl}/call`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    userId: targetUserId,
                    dmChannelId: targetDmChannelId,
                    message: cleanText,
                    callbackUrl: `http://127.0.0.1:${inboundPort}/inbound`,
                    channelId: "voice-call",
                    maxTurns: maxConversationTurns,
                    agentResponseTimeout,
                    keepRecordings,
                  }),
                });

                if (res.ok) {
                  const data = (await res.json()) as { callId: string };
                  activeCalls.set(targetUserId, data.callId);
                  console.log(
                    `[voice-call] Started call ${data.callId} to ${targetUserId}`
                  );
                }

                return { ok: res.ok };
              }
            } catch (err) {
              console.error(`[voice-call] Error: ${err}`);
              return { ok: false };
            }
          },
        },
      },
    });

    // ── Start Inbound Callback Server ──
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "POST" && req.url === "/inbound") {
          try {
            const body = await parseBody(req);
            const { type, callId, userId, transcription, isSilence, status, turnCount } = body;

            if (type === "transcription") {
              // Route transcription to agent
              const text = isSilence
                ? `[Stille — der Benutzer hat nichts gesagt (Runde ${turnCount})]`
                : transcription;

              console.log(
                `[voice-call] Turn ${turnCount} from ${userId}: ${(transcription || "(silence)").substring(0, 80)}`
              );

              try {
                await fetch("http://127.0.0.1:18789/hooks/wake", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    text,
                    channel: "voice-call",
                    channelId: "voice-call",
                    userId,
                  }),
                });
              } catch (wakeErr) {
                console.error(`[voice-call] Failed to send to agent: ${wakeErr}`);
              }
            } else if (type === "call_ended") {
              // Clean up active call tracking
              console.log(
                `[voice-call] Call ${callId} ended: ${status} (${body.totalTurns} turns, ${body.duration?.toFixed(1)}s)`
              );

              // Remove from activeCalls map
              for (const [uid, cid] of activeCalls) {
                if (cid === callId) {
                  activeCalls.delete(uid);
                  break;
                }
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            console.error(`[voice-call] Inbound error: ${err}`);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal error" }));
          }
        } else if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              plugin: "voice-call",
              activeCalls: activeCalls.size,
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      }
    );

    server.listen(inboundPort, () => {
      console.log(
        `[voice-call] Inbound server listening on port ${inboundPort}`
      );
    });

    console.log(
      `[voice-call] Plugin registered. DM-Call: ${dmCallServiceUrl}, Inbound: :${inboundPort}`
    );
  },
};

export default plugin;
