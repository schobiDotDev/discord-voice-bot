/**
 * Discord Voice Bridge Plugin for OpenClaw
 *
 * Bidirectional voice channel integration:
 *
 * Inbound (user speaks → agent):
 *   1. Voice Bot transcribes speech → POST /inbound to this plugin
 *   2. Plugin formats message with username and sends to agent session
 *   3. Agent processes and responds
 *
 * Outbound (agent responds → user hears):
 *   4. Agent response goes through sendText()
 *   5. Plugin cleans markdown and sends to Voice Bot /speak endpoint
 *   6. Voice Bot plays TTS in Discord voice channel
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

let api: OpenClawPluginApi;

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

const plugin = {
  id: "discord-voice",
  name: "Discord Voice Channel",
  description:
    "Discord voice channel integration for OpenClaw — bidirectional voice bridge with STT/TTS",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      voiceBotUrl: {
        type: "string" as const,
        default: "http://localhost:8788",
      },
      inboundPort: {
        type: "number" as const,
        default: 8790,
      },
      ownerId: {
        type: "string" as const,
      },
    },
  },
  register(pluginApi: OpenClawPluginApi) {
    api = pluginApi;

    const config =
      pluginApi.config?.plugins?.entries?.["discord-voice"]?.config ?? {};
    const voiceBotUrl = (config as any).voiceBotUrl ?? "http://localhost:8788";
    const inboundPort = (config as any).inboundPort ?? 8790;

    // ── Register Channel (outbound: agent → voice bot) ──
    pluginApi.registerChannel({
      plugin: {
        id: "discord-voice",
        meta: {
          id: "discord-voice",
          label: "Discord Voice",
          selectionLabel: "Discord Voice Channel",
          docsPath: "/channels/discord-voice",
          blurb:
            "Discord voice channel integration with STT/TTS.",
          aliases: ["voice", "dv"],
        },
        capabilities: {
          chatTypes: ["group"] as const,
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
            // Clean text for speech (remove markdown, links, etc.)
            const cleanText = opts.text
              .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
              .replace(/[*_~`#]/g, "")
              .replace(/\n{3,}/g, "\n\n")
              .replace(/NO_REPLY/g, "")
              .trim();

            if (!cleanText) return { ok: true };

            try {
              const res = await fetch(`${voiceBotUrl}/speak`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: cleanText }),
              });
              return { ok: res.ok };
            } catch (err) {
              console.error(`[discord-voice] Speak failed: ${err}`);
              return { ok: false };
            }
          },
        },
      },
    });

    // ── Start Inbound HTTP Server (voice bot → agent) ──
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        // CORS headers for local development
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
            const { text, userId, userName, channelId, guildId } = body;

            if (!text) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "text is required" }));
              return;
            }

            // Format with username so agent knows who is speaking
            const formatted = userName ? `${userName}: ${text}` : text;

            console.log(
              `[discord-voice] Inbound from ${userName ?? "unknown"} (${userId ?? "?"}): ${text.substring(0, 80)}`
            );

            // Route to agent session via hooks/wake
            // TODO: When OpenClaw plugin SDK exposes session-level message routing,
            // use that instead. For now, hooks/wake sends to the main agent session.
            try {
              const wakeUrl = "http://127.0.0.1:18789/hooks/wake";
              await fetch(wakeUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  text: formatted,
                  channel: "discord-voice",
                  channelId: channelId ?? "default",
                }),
              });
            } catch (wakeErr) {
              console.error(
                `[discord-voice] Failed to send to agent: ${wakeErr}`
              );
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            console.error(`[discord-voice] Inbound error: ${err}`);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal error" }));
          }
        } else if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", plugin: "discord-voice" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      }
    );

    server.listen(inboundPort, () => {
      console.log(
        `[discord-voice] Inbound server listening on port ${inboundPort}`
      );
    });

    console.log(
      `[discord-voice] Plugin registered. Voice Bot: ${voiceBotUrl}, Inbound: :${inboundPort}`
    );
  },
};

export default plugin;
