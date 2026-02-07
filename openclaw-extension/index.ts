/**
 * Discord Voice Bridge Plugin for OpenClaw
 * 
 * Runs an HTTP server that bridges the Discord Voice Bot to OpenClaw's agent.
 * 
 * Flow:
 *   1. Voice Bot transcribes speech → POST /voice/transcription to this plugin
 *   2. Plugin sends to OpenClaw agent via hooks/wake (system event)
 *   3. Agent processes and responds
 *   4. Plugin delivers response to Voice Bot /speak endpoint
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

let api: OpenClawPluginApi;

const plugin = {
  id: "discord-voice",
  name: "Discord Voice Channel",
  description: "Discord DM voice calls via BlackHole audio routing — bidirectional voice channel for OpenClaw",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      voiceBotUrl: {
        type: "string" as const,
        default: "http://localhost:8788",
      },
      ownerId: {
        type: "string" as const,
      },
    },
  },
  register(pluginApi: OpenClawPluginApi) {
    api = pluginApi;

    const config = pluginApi.config?.plugins?.entries?.["discord-voice"]?.config ?? {};
    const voiceBotUrl = (config as any).voiceBotUrl ?? "http://localhost:8788";

    // Register the channel for routing
    pluginApi.registerChannel({
      plugin: {
        id: "discord-voice",
        meta: {
          id: "discord-voice",
          label: "Discord Voice",
          selectionLabel: "Discord Voice (DM Calls)",
          docsPath: "/channels/discord-voice",
          blurb: "Discord DM voice calls via BlackHole audio routing.",
          aliases: ["voice", "dv"],
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
            // Clean text for speech
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

    console.log(`[discord-voice] Plugin registered. Voice Bot: ${voiceBotUrl}`);
  },
};

export default plugin;
