# OpenClaw GLM Realtime

A [Zhipu GLM Realtime](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime)
voice provider plugin for [OpenClaw](https://openclaw.ai). It adds a streaming,
server-VAD voice-chat provider (`zhipu`) so you can talk to your OpenClaw agent
through Zhipu's GLM Realtime API.

## Requirements

- OpenClaw gateway `>= 2026.6.9`
- A Zhipu BigModel API key with GLM Realtime access (`glm-realtime-plus` tier)

## Install

```bash
clawhub plugin install @shushushv/openclaw-glm-realtime
```

## Configure

Set your API key via environment variable:

```bash
export ZHIPU_API_KEY="your-zhipu-api-key"
```

Or configure it in `openclaw.json` under the provider config. Recognized keys:

| Key | Aliases | Default | Notes |
|-----|---------|---------|-------|
| `apiKey` | `api_key`, `ZHIPU_API_KEY` | — | Falls back to the `ZHIPU_API_KEY` env var |
| `model` | — | `glm-realtime-plus` | `glm-realtime-plus` recommended; `glm-realtime` is an alias to a paid backend |
| `voice` | `speaker` | `tongtong` | GLM voice name |

The provider registers as `zhipu` (label: **Zhipu GLM Realtime**), with aliases
`glm`, `glm-realtime`, `zhipu-realtime`.

## How it works

- Connects to `wss://open.bigmodel.cn/api/paas/v4/realtime` with `Bearer` auth.
- Streams microphone audio as 24 kHz mono PCM frames, each tagged with a
  `client_timestamp` so the server-side VAD can detect end-of-speech.
- Uses `turn_detection: server_vad` — the server auto-commits and responds; no
  manual commit/response is needed.
- Supports tool calls via `response.function_call_arguments.done`.

## Known limitations

- **No proactive greeting**: in server-VAD mode GLM ignores a `response.create`
  that has no preceding user audio, so an opening line cannot be triggered.
- **"Speaking" UI indicator**: a general gateway-relay limitation, not specific
  to this provider.

## License

MIT
