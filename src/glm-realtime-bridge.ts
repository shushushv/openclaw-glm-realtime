import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "ws";

const log = createSubsystemLogger("glm-realtime");

export const GLM_REALTIME_ENDPOINT = "wss://open.bigmodel.cn/api/paas/v4/realtime";

// The console exposes Air / Flash / Plus. Only `-plus` routes to an audio backend
// this account can use; the bare `glm-realtime` alias bills an unfunded backend and
// `-flash` / `-air` 404 (model_not_found). Keep `-plus` as the safe default.
const DEFAULT_MODEL = "glm-realtime-plus";
const DEFAULT_VOICE = "tongtong";

// Fail the connect() promise if session.updated never arrives (e.g. socket opens
// but the server stalls the handshake), instead of hanging forever.
const CONNECT_TIMEOUT_MS = 15_000;

export type GlmRealtimeBridgeParams = RealtimeVoiceBridgeCreateRequest & {
  apiKey: string;
  model?: string;
  voice?: string;
  /** Override WebSocket endpoint — for testing only. */
  _testEndpoint?: string;
};

type GlmServerEvent = {
  type: string;
  [key: string]: unknown;
};

function toolsToGlmFormat(tools: RealtimeVoiceTool[] | undefined): unknown[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function createGlmRealtimeBridge(params: GlmRealtimeBridgeParams): RealtimeVoiceBridge {
  let ws: WebSocket | null = null;
  let ready = false;
  let closed = false;
  let connectResolve: (() => void) | null = null;
  let connectReject: ((err: Error) => void) | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  // Settle the connect() promise exactly once and clear the handshake timeout.
  const settleConnect = (err?: Error): void => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (err) connectReject?.(err);
    else connectResolve?.();
    connectResolve = null;
    connectReject = null;
  };

  const emitEvent = (direction: "client" | "server", type: string): void => {
    params.onEvent?.({ direction, type });
  };

  const sendJson = (msg: Record<string, unknown>): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Every client event carries client_timestamp (docs "公共参数"). It is REQUIRED
    // on input_audio_buffer.append: server_vad measures silence from these
    // timestamps to fire speech_stopped. Without it GLM never ends the turn and
    // idle-closes after ~8s.
    ws.send(JSON.stringify({ client_timestamp: Date.now(), ...msg }));
    emitEvent("client", msg["type"] as string);
  };

  const sendSessionUpdate = (): void => {
    const session: Record<string, unknown> = {
      model: params.model ?? DEFAULT_MODEL,
      modalities: ["text", "audio"],
      voice: params.voice ?? DEFAULT_VOICE,
      // Raw 24kHz PCM16 in. server_vad segments turns from per-frame
      // client_timestamp (added in sendJson), not the audio container — verified
      // pcm24 works identically to WAV framing, so we skip the WAV header.
      input_audio_format: "pcm24",
      output_audio_format: "pcm",
      temperature: 0.8,
      // Required by GLM Realtime schema — without this field session.update is rejected.
      beta_fields: { chat_mode: "audio" },
    };

    if (params.autoRespondToAudio !== false) {
      session["turn_detection"] = {
        type: "server_vad",
        create_response: true,
        interrupt_response: params.interruptResponseOnInputAudio !== false,
      };
    } else {
      // No auto-response: still let server VAD segment, but don't auto-create a reply.
      session["turn_detection"] = { type: "server_vad", create_response: false };
    }

    if (params.instructions) {
      session["instructions"] = params.instructions;
    }

    const glmTools = toolsToGlmFormat(params.tools);
    if (glmTools.length > 0) {
      session["tools"] = glmTools;
      // GLM Realtime does not support tool_choice — omit it
    }

    sendJson({ type: "session.update", event_id: randomUUID(), session });
  };

  const handleServerEvent = (event: GlmServerEvent): void => {
    emitEvent("server", event.type);

    switch (event.type) {
      case "session.created":
        log.info("session.created, sending session.update");
        sendSessionUpdate();
        return;

      case "session.updated":
        log.info("session.updated, bridge ready");
        if (!ready) {
          ready = true;
          settleConnect();
          params.onReady?.();
        }
        return;

      case "error": {
        const err = event["error"] as { message?: string; code?: string } | undefined;
        const msg = err?.message ?? "GLM realtime error";
        log.warn(`server error: ${msg}`);
        const error = new Error(`GLM Realtime: ${msg}`);
        params.onError?.(error);
        settleConnect(error);
        return;
      }

      case "response.audio.delta": {
        const b64 = event["delta"] as string | undefined;
        if (b64) {
          params.onAudio(Buffer.from(b64, "base64"));
        }
        return;
      }

      case "response.audio.done":
        return;

      case "response.done": {
        // Surface non-OK terminal states (failed / content filter / max tokens).
        // GLM usually also emits an `error` event, but not always.
        const response = event["response"] as
          | { status?: string; status_details?: { error?: { message?: string } } }
          | undefined;
        if (response?.status === "failed") {
          const msg = response.status_details?.error?.message ?? "response failed";
          log.warn(`response failed: ${msg}`);
          params.onError?.(new Error(`GLM Realtime: ${msg}`));
        }
        return;
      }

      case "response.cancelled":
        params.onClearAudio();
        return;

      case "input_audio_buffer.speech_started":
        // User started speaking — clear buffered playback for barge-in.
        if (params.interruptResponseOnInputAudio !== false) {
          params.onClearAudio();
        }
        return;

      case "input_audio_buffer.speech_stopped":
        // server_vad auto-commits the turn and (if create_response) starts the reply.
        return;

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event["transcript"] as string | undefined;
        if (transcript) {
          params.onTranscript?.("user", transcript, true);
        }
        return;
      }

      case "response.audio_transcript.delta": {
        const delta = event["delta"] as string | undefined;
        if (delta) {
          params.onTranscript?.("assistant", delta, false);
        }
        return;
      }

      case "response.audio_transcript.done": {
        const transcript = event["transcript"] as string | undefined;
        if (transcript) {
          params.onTranscript?.("assistant", transcript, true);
        }
        return;
      }

      case "response.function_call_arguments.done": {
        // GLM delivers the whole tool call in this single event — there is no
        // .delta or response.output_item.added (those are OpenAI-only). The done
        // event carries call_id / name / arguments / item_id directly.
        const callId = event["call_id"] as string | undefined;
        const name = event["name"] as string | undefined;
        const itemId = event["item_id"] as string | undefined;
        const argsStr = event["arguments"] as string | undefined;
        if (!callId || !name) return;

        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(argsStr ?? "{}");
        } catch {
          parsedArgs = {};
        }

        params.onToolCall?.({ itemId: itemId ?? callId, callId, name, args: parsedArgs });
        return;
      }

      default:
        return;
    }
  };

  const closeInternal = (reason: "completed" | "error" | "client" | "remote"): void => {
    if (closed) return;
    closed = true;
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    try {
      ws?.close();
    } catch {
      // ignore
    }
    ws = null;
    params.onClose?.(reason === "error" ? "error" : "completed");
  };

  const bridge: RealtimeVoiceBridge = {
    supportsToolResultContinuation: false,

    async connect(): Promise<void> {
      if (closed) throw new Error("bridge already closed");

      ws = new WebSocket(params._testEndpoint ?? GLM_REALTIME_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
        },
      });

      const promise = new Promise<void>((resolve, reject) => {
        connectResolve = resolve;
        connectReject = reject;
      });

      connectTimer = setTimeout(() => {
        log.warn("connect timed out waiting for session.updated");
        settleConnect(new Error("GLM Realtime: connection timed out"));
        closeInternal("error");
      }, CONNECT_TIMEOUT_MS);

      log.info(`connecting to ${GLM_REALTIME_ENDPOINT}`);

      ws.on("open", () => {
        log.info("ws open, waiting for session.created");
      });

      ws.on("message", (data) => {
        let event: GlmServerEvent;
        try {
          event = JSON.parse(data.toString()) as GlmServerEvent;
        } catch (err) {
          log.warn(`failed to parse server message: ${err}`);
          return;
        }
        handleServerEvent(event);
      });

      ws.on("error", (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn(`ws error: ${error.message}`);
        params.onError?.(error);
        settleConnect(error);
      });

      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => {
          log.warn(`ws unexpected-response status=${res.statusCode} body=${body.slice(0, 300)}`);
          const err = new Error(`GLM realtime HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
          params.onError?.(err);
          settleConnect(err);
        });
      });

      ws.on("close", (code) => {
        log.info(`ws close code=${code} ready=${ready}`);
        if (!closed) {
          // Clean 1000 close after ready = normal completion; a pre-ready drop or
          // abnormal code (e.g. 1006) is an error so the UI can surface/reconnect.
          closeInternal(ready && code === 1000 ? "remote" : "error");
        }
      });

      return promise;
    },

    sendAudio(audio: Buffer): void {
      if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return;
      // Forward raw 24kHz PCM16 as-is (declared pcm24); client_timestamp in
      // sendJson is what drives server_vad segmentation.
      sendJson({
        type: "input_audio_buffer.append",
        event_id: randomUUID(),
        audio: audio.toString("base64"),
      });
    },

    sendUserMessage(text: string): void {
      if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return;
      sendJson({
        type: "conversation.item.create",
        event_id: randomUUID(),
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      sendJson({ type: "response.create", event_id: randomUUID() });
      log.info(`sendUserMessage: ${text.slice(0, 80)}`);
    },

    handleBargeIn(): void {
      if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return;
      // Ignores RealtimeVoiceBargeInOptions: GLM cancels the whole active response
      // on barge-in (no partial-keep option).
      sendJson({ type: "response.cancel", event_id: randomUUID() });
      params.onClearAudio();
      log.info("handleBargeIn: sent response.cancel");
    },

    // triggerGreeting is intentionally NOT implemented: in server_vad mode GLM
    // ignores a response.create that has no prior user input (verified — no
    // response.created/audio at all), so the assistant cannot open unprompted.

    setMediaTimestamp(_ts: number): void {
      // GLM does not use client-side media timestamps.
    },

    submitToolResult(callId: string, result: unknown): void {
      if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return;
      // Ignores RealtimeVoiceToolResultOptions.willContinue: supportsToolResultContinuation
      // is false, so each result is final — submit the output then request a reply.
      sendJson({
        type: "conversation.item.create",
        event_id: randomUUID(),
        item: {
          type: "function_call_output",
          call_id: callId,
          output: typeof result === "string" ? result : JSON.stringify(result),
        },
      });
      sendJson({ type: "response.create", event_id: randomUUID() });
    },

    acknowledgeMark(): void {
      // GLM does not use mark/ack signals.
    },

    close(): void {
      if (closed) return;
      closeInternal("client");
    },

    isConnected(): boolean {
      return ready && !closed;
    },
  };

  return bridge;
}
