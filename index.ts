import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildGlmRealtimeVoiceProvider } from "./src/glm-realtime-provider.js";

export default definePluginEntry({
  id: "glm-realtime",
  name: "GLM Realtime",
  description: "Zhipu GLM Realtime voice provider for OpenClaw",
  register(api: OpenClawPluginApi) {
    api.registerRealtimeVoiceProvider(buildGlmRealtimeVoiceProvider());
  },
});

export { buildGlmRealtimeVoiceProvider } from "./src/glm-realtime-provider.js";
