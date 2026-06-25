import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock SDK + bridge before importing the module under test so createBridge does
// not open a real socket and the audio-format constant is a plain object.
vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: {
    encoding: "pcm16",
    sampleRateHz: 24000,
    channels: 1,
  },
}));
vi.mock("./glm-realtime-bridge.js", () => ({
  createGlmRealtimeBridge: vi.fn(() => ({ connect: vi.fn(), close: vi.fn() })),
}));

const { buildGlmRealtimeVoiceProvider } = await import("./glm-realtime-provider.js");
const { createGlmRealtimeBridge } = await import("./glm-realtime-bridge.js");

const PCM16_24KHZ = { encoding: "pcm16", sampleRateHz: 24000, channels: 1 };

// The provider reads ZHIPU_API_KEY from the environment; isolate it per test so
// a real key on the dev machine cannot leak into assertions.
const ORIGINAL_ENV = process.env["ZHIPU_API_KEY"];
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["ZHIPU_API_KEY"];
});
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env["ZHIPU_API_KEY"];
  else process.env["ZHIPU_API_KEY"] = ORIGINAL_ENV;
});

describe("buildGlmRealtimeVoiceProvider", () => {
  const provider = buildGlmRealtimeVoiceProvider();

  it("has the correct id, label and default model", () => {
    expect(provider.id).toBe("zhipu");
    expect(provider.label).toBe("Zhipu GLM Realtime");
    expect(provider.defaultModel).toBe("glm-realtime-plus");
  });

  it("exposes the expected aliases", () => {
    expect(provider.aliases).toContain("glm");
    expect(provider.aliases).toContain("glm-realtime");
    expect(provider.aliases).toContain("zhipu-realtime");
  });

  describe("capabilities", () => {
    it("declares only the gateway-relay transport", () => {
      expect(provider.capabilities?.transports).toEqual(["gateway-relay"]);
    });

    it("declares PCM16@24kHz input/output formats", () => {
      expect(provider.capabilities?.inputAudioFormats).toEqual([PCM16_24KHZ]);
      expect(provider.capabilities?.outputAudioFormats).toEqual([PCM16_24KHZ]);
    });

    it("supports barge-in and tool calls", () => {
      expect(provider.capabilities?.supportsBargeIn).toBe(true);
      expect(provider.capabilities?.supportsToolCalls).toBe(true);
    });

    it("does not support session resumption or browser sessions", () => {
      expect(provider.capabilities?.supportsSessionResumption).toBe(false);
      expect(provider.capabilities?.supportsBrowserSession).toBe(false);
    });
  });

  describe("isConfigured", () => {
    it("returns true when apiKey is present", () => {
      expect(provider.isConfigured?.({ providerConfig: { apiKey: "k" } } as never)).toBe(true);
    });

    it("accepts the api_key alias", () => {
      expect(provider.isConfigured?.({ providerConfig: { api_key: "k" } } as never)).toBe(true);
    });

    it("accepts the apikey alias", () => {
      expect(provider.isConfigured?.({ providerConfig: { apikey: "k" } } as never)).toBe(true);
    });

    it("accepts the ZHIPU_API_KEY field alias", () => {
      expect(provider.isConfigured?.({ providerConfig: { ZHIPU_API_KEY: "k" } } as never)).toBe(
        true,
      );
    });

    it("falls back to the ZHIPU_API_KEY environment variable", () => {
      process.env["ZHIPU_API_KEY"] = "env-key";
      expect(provider.isConfigured?.({ providerConfig: {} } as never)).toBe(true);
    });

    it("returns false for empty config and no env", () => {
      expect(provider.isConfigured?.({ providerConfig: {} } as never)).toBe(false);
    });

    it("returns false for whitespace-only apiKey", () => {
      expect(provider.isConfigured?.({ providerConfig: { apiKey: "   " } } as never)).toBe(false);
    });
  });

  describe("resolveConfig", () => {
    it("normalizes api_key to apiKey", () => {
      const result = provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: { api_key: "k" },
      } as never) as Record<string, unknown>;
      expect(result["apiKey"]).toBe("k");
    });

    it("normalizes speaker to voice", () => {
      const result = provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: { apiKey: "k", speaker: "tongtong" },
      } as never) as Record<string, unknown>;
      expect(result["voice"]).toBe("tongtong");
    });

    it("falls back to the ZHIPU_API_KEY environment variable", () => {
      process.env["ZHIPU_API_KEY"] = "env-key";
      const result = provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: {},
      } as never) as Record<string, unknown>;
      expect(result["apiKey"]).toBe("env-key");
    });

    it("prefers explicit apiKey over the environment variable", () => {
      process.env["ZHIPU_API_KEY"] = "env-key";
      const result = provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: { apiKey: "explicit" },
      } as never) as Record<string, unknown>;
      expect(result["apiKey"]).toBe("explicit");
    });

    it("preserves existing raw config fields", () => {
      const result = provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: { apiKey: "k", extra: "value" },
      } as never) as Record<string, unknown>;
      expect(result["extra"]).toBe("value");
    });
  });

  describe("createBridge", () => {
    const baseReq = {
      providerConfig: { apiKey: "k" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    } as never;

    it("calls createGlmRealtimeBridge with the apiKey", () => {
      provider.createBridge(baseReq);
      expect(createGlmRealtimeBridge).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "k" }),
      );
    });

    it("forwards model and voice from providerConfig", () => {
      provider.createBridge({
        ...(baseReq as object),
        providerConfig: { apiKey: "k", model: "glm-realtime", speaker: "xiaoxiao" },
      } as never);
      expect(createGlmRealtimeBridge).toHaveBeenCalledWith(
        expect.objectContaining({ model: "glm-realtime", voice: "xiaoxiao" }),
      );
    });

    it("uses the ZHIPU_API_KEY environment variable when config has none", () => {
      process.env["ZHIPU_API_KEY"] = "env-key";
      provider.createBridge({
        ...(baseReq as object),
        providerConfig: {},
      } as never);
      expect(createGlmRealtimeBridge).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "env-key" }),
      );
    });

    it("throws when no apiKey is available", () => {
      expect(() =>
        provider.createBridge({
          ...(baseReq as object),
          providerConfig: {},
        } as never),
      ).toThrow(/API key/);
      expect(createGlmRealtimeBridge).not.toHaveBeenCalled();
    });
  });
});
