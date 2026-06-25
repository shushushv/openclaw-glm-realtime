import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import type {
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceProviderResolveConfigContext,
} from "openclaw/plugin-sdk/realtime-voice";
import { createGlmRealtimeBridge } from "./glm-realtime-bridge.js";

type GlmNormalizedConfig = {
  apiKey?: string;
  model?: string;
  voice?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readString(record: unknown, key: string): string | undefined {
  if (record && typeof record === "object" && !Array.isArray(record)) {
    return trimToUndefined((record as Record<string, unknown>)[key]);
  }
  return undefined;
}

function normalizeConfig(raw: unknown): GlmNormalizedConfig {
  return {
    apiKey:
      readString(raw, "apiKey") ??
      readString(raw, "api_key") ??
      readString(raw, "apikey") ??
      readString(raw, "ZHIPU_API_KEY"),
    model: readString(raw, "model"),
    voice: readString(raw, "voice") ?? readString(raw, "speaker"),
  };
}

export function buildGlmRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "zhipu",
    label: "Zhipu GLM Realtime",
    defaultModel: "glm-realtime-plus",
    aliases: ["glm", "glm-realtime", "zhipu-realtime"],
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      supportsBargeIn: true,
      supportsToolCalls: true,
      supportsSessionResumption: false,
      supportsBrowserSession: false,
    },
    resolveConfig: (ctx: RealtimeVoiceProviderResolveConfigContext) => {
      const normalized = normalizeConfig(ctx.rawConfig);
      const envApiKey = trimToUndefined(process.env["ZHIPU_API_KEY"]);
      return {
        ...ctx.rawConfig,
        apiKey: normalized.apiKey ?? envApiKey,
        model: normalized.model,
        voice: normalized.voice,
      };
    },
    isConfigured: (ctx: RealtimeVoiceProviderConfiguredContext) => {
      const normalized = normalizeConfig(ctx.providerConfig);
      const envApiKey = trimToUndefined(process.env["ZHIPU_API_KEY"]);
      return Boolean(normalized.apiKey ?? envApiKey);
    },
    createBridge: (req) => {
      // req.providerConfig is already normalized by resolveConfig, so one read
      // here covers model/voice — no second providerConfig fallback needed.
      const normalized = normalizeConfig(req.providerConfig);
      const apiKey = normalized.apiKey ?? trimToUndefined(process.env["ZHIPU_API_KEY"]);
      if (!apiKey) {
        throw new Error(
          "GLM Realtime provider requires an API key. Set ZHIPU_API_KEY or configure apiKey.",
        );
      }
      return createGlmRealtimeBridge({
        ...req,
        apiKey,
        model: normalized.model,
        voice: normalized.voice,
      });
    },
  };
}
