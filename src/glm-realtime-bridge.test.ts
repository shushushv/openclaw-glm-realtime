import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";

// Typed mock helpers so VS Code doesn't complain about vi.fn() callback mismatches.
const audioMock = () => vi.fn<(audio: Buffer) => void>();
const voidMock = () => vi.fn<() => void>();
const anyMock = () => vi.fn<(...args: unknown[]) => void>();

// Mock SDK dependencies before importing bridge
vi.mock("openclaw/plugin-sdk/core", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  // identity resample — skip actual DSP in tests
  resamplePcm: (buf: Buffer, _from: number, to: number) => {
    // simulate 24kHz→16kHz by taking 2/3 of bytes
    if (_from === 24000 && to === 16000) {
      const out = Buffer.alloc(Math.floor(buf.length * 2 / 3));
      buf.copy(out);
      return out;
    }
    return buf;
  },
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: { encoding: "pcm16", sampleRateHz: 24000 },
}));

const { createGlmRealtimeBridge } = await import("./glm-realtime-bridge.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

type FakeServer = {
  wss: WebSocketServer;
  port: number;
  lastConn: WebSocket | null;
  authHeader: string | undefined;
  close(): Promise<void>;
};

function startFakeServer(): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("bad address"));
        return;
      }
      const server: FakeServer = {
        wss,
        port: addr.port,
        lastConn: null,
        authHeader: undefined,
        close: () =>
          new Promise<void>((res) => {
            server.lastConn?.close();
            wss.close(() => res());
          }),
      };
      wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        server.lastConn = ws;
        server.authHeader = req.headers["authorization"] as string | undefined;
      });
      resolve(server);
    });
    wss.on("error", reject);
  });
}

function serverSend(server: FakeServer, msg: Record<string, unknown>): void {
  server.lastConn?.send(JSON.stringify(msg));
}

const wait = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

type BridgeParams = Parameters<typeof createGlmRealtimeBridge>[0];

// Build a bridge with the always-required fields defaulted (apiKey, providerConfig,
// onAudio, onClearAudio). Overrides are still type-checked against the real param
// shape; the cast only absorbs the Partial-spread widening of those defaults.
function makeBridge(
  overrides: Partial<BridgeParams> = {},
): ReturnType<typeof createGlmRealtimeBridge> {
  return createGlmRealtimeBridge({
    apiKey: "key",
    providerConfig: {},
    onAudio: audioMock(),
    onClearAudio: voidMock(),
    ...overrides,
  } as BridgeParams);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createGlmRealtimeBridge", () => {
  const servers: FakeServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  // Spin up a fake server, connect a bridge, drive the session.created /
  // session.updated handshake, and capture every client message. Resolves once
  // the bridge is ready. Pass overrides (callbacks, tools, flags) via `params`.
  async function connectedBridge(
    params: Partial<Parameters<typeof createGlmRealtimeBridge>[0]> = {},
  ): Promise<{
    server: FakeServer;
    bridge: ReturnType<typeof createGlmRealtimeBridge>;
    received: Record<string, unknown>[];
  }> {
    const server = await startFakeServer();
    servers.push(server);
    const received: Record<string, unknown>[] = [];
    const connectionReady = new Promise<void>((res) => {
      server.wss.once("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        res();
      });
    });
    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
      ...params,
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });
    const connectPromise = bridge.connect();
    await connectionReady;
    serverSend(server, { type: "session.created" });
    await wait(20); // let the bridge emit session.update
    serverSend(server, { type: "session.updated" });
    await connectPromise;
    return { server, bridge, received };
  }

  it("sends Authorization header with Bearer prefix", async () => {
    const server = await startFakeServer();
    servers.push(server);

    const bridge = makeBridge({
      apiKey: "test-api-key-123",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });

    const connectPromise = bridge.connect();

    // Wait for connection then simulate server handshake
    await new Promise((r) => setTimeout(r, 50));
    serverSend(server, { type: "session.created", session: {} });
    serverSend(server, { type: "session.updated", session: {} });
    await connectPromise;

    expect(server.authHeader).toBe("Bearer test-api-key-123");
  });

  it("sends session.update with correct defaults after session.created", async () => {
    const server = await startFakeServer();
    servers.push(server);

    const received: Record<string, unknown>[] = [];
    // Capture messages by patching the connection after it's established
    const connectionReady = new Promise<void>((res) => {
      server.wss.once("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        res();
      });
    });

    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });

    const connectPromise = bridge.connect();
    await connectionReady; // wait until ws is connected and message listener is registered
    serverSend(server, { type: "session.created" });
    await new Promise((r) => setTimeout(r, 30)); // let bridge send session.update
    serverSend(server, { type: "session.updated" });
    await connectPromise;

    const sessionUpdate = received.find((m) => m["type"] === "session.update") as {
      session: Record<string, unknown>;
    } | undefined;
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate?.session?.["model"]).toBe("glm-realtime-plus");
    expect(sessionUpdate?.session?.["input_audio_format"]).toBe("pcm24");
    expect(sessionUpdate?.session?.["output_audio_format"]).toBe("pcm");
    expect((sessionUpdate?.session?.["beta_fields"] as Record<string, unknown>)?.["chat_mode"]).toBe("audio");
    // server_vad segments turns server-side.
    expect((sessionUpdate?.session?.["turn_detection"] as Record<string, unknown>)?.["type"]).toBe(
      "server_vad",
    );
    // GLM Realtime does not support tool_choice — must not be sent
    expect(sessionUpdate?.session?.["tool_choice"]).toBeUndefined();
  });

  it("delivers audio from server to onAudio callback", async () => {
    const server = await startFakeServer();
    servers.push(server);

    const onAudio = audioMock();
    const bridge = makeBridge({
      apiKey: "key",
      onAudio,
      onClearAudio: voidMock(),
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });

    const connectPromise = bridge.connect();
    await new Promise((r) => setTimeout(r, 50));
    serverSend(server, { type: "session.created" });
    serverSend(server, { type: "session.updated" });
    await connectPromise;

    const pcm = Buffer.alloc(100, 0xaa);
    serverSend(server, {
      type: "response.audio.delta",
      delta: pcm.toString("base64"),
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onAudio).toHaveBeenCalledOnce();
    expect(onAudio.mock.calls[0]?.[0]).toEqual(pcm);
  });

  it("calls onToolCall with correct fields on function_call completion", async () => {
    const server = await startFakeServer();
    servers.push(server);

    const onToolCall = anyMock();
    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
      onToolCall,
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });

    const connectPromise = bridge.connect();
    await new Promise((r) => setTimeout(r, 50));
    serverSend(server, { type: "session.created" });
    serverSend(server, { type: "session.updated" });
    await connectPromise;

    // GLM sends the whole tool call in one .done event (item_id included);
    // there is no output_item.added / .delta.
    serverSend(server, {
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "get_weather",
      item_id: "item-1",
      arguments: '{"city":"Beijing"}',
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item-1",
      callId: "call-1",
      name: "get_weather",
      args: { city: "Beijing" },
    });
  });

  it("sends response.cancel and clears audio on handleBargeIn", async () => {
    const server = await startFakeServer();
    servers.push(server);

    const received: Record<string, unknown>[] = [];
    const connectionReady = new Promise<void>((res) => {
      server.wss.once("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        res();
      });
    });

    const onClearAudio = voidMock();
    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio,
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });

    const connectPromise = bridge.connect();
    await connectionReady;
    serverSend(server, { type: "session.created" });
    await new Promise((r) => setTimeout(r, 20));
    serverSend(server, { type: "session.updated" });
    await connectPromise;

    bridge.handleBargeIn?.();

    await new Promise((r) => setTimeout(r, 20));
    expect(received.find((m) => m["type"] === "response.cancel")).toBeDefined();
    expect(onClearAudio).toHaveBeenCalledOnce();
  });

  // ── Audio framing ────────────────────────────────────────────────────────────

  it("forwards raw PCM with a client_timestamp (no WAV framing)", async () => {
    const server = await startFakeServer();
    servers.push(server);
    const received: Record<string, unknown>[] = [];
    const connectionReady = new Promise<void>((res) => {
      server.wss.once("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        res();
      });
    });
    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });
    const connectPromise = bridge.connect();
    await connectionReady;
    serverSend(server, { type: "session.created" });
    await new Promise((r) => setTimeout(r, 20));
    serverSend(server, { type: "session.updated" });
    await connectPromise;

    const pcm = Buffer.alloc(4800, 0x11);
    bridge.sendAudio(pcm);

    await new Promise((r) => setTimeout(r, 20));
    const append = received.find((m) => m["type"] === "input_audio_buffer.append") as
      | { audio?: string; client_timestamp?: number }
      | undefined;
    expect(append).toBeDefined();
    // server_vad segments turns from this per-frame timestamp, not the container.
    expect(typeof append?.client_timestamp).toBe("number");
    // Raw PCM passes through unchanged — no WAV header added.
    const decoded = Buffer.from(append?.audio ?? "", "base64");
    expect(decoded.length).toBe(pcm.length);
    expect(decoded.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
    expect(decoded.equals(pcm)).toBe(true);
  });

  // ── session.update variants ───────────────────────────────────────────────────

  it("includes tools (GLM function format, no tool_choice) when provided", async () => {
    const { received } = await connectedBridge({
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    const su = received.find((m) => m["type"] === "session.update") as
      | { session: Record<string, unknown> }
      | undefined;
    expect(su?.session["tools"]).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get the weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
    expect(su?.session["tool_choice"]).toBeUndefined();
  });

  it("includes instructions when provided", async () => {
    const { received } = await connectedBridge({ instructions: "Be concise." });
    const su = received.find((m) => m["type"] === "session.update") as
      | { session: Record<string, unknown> }
      | undefined;
    expect(su?.session["instructions"]).toBe("Be concise.");
  });

  it("sets create_response:false when autoRespondToAudio is false", async () => {
    const { received } = await connectedBridge({ autoRespondToAudio: false });
    const su = received.find((m) => m["type"] === "session.update") as
      | { session: Record<string, unknown> }
      | undefined;
    expect(su?.session["turn_detection"]).toEqual({ type: "server_vad", create_response: false });
  });

  it("sets interrupt_response:false when interruptResponseOnInputAudio is false", async () => {
    const { received } = await connectedBridge({ interruptResponseOnInputAudio: false });
    const td = (
      received.find((m) => m["type"] === "session.update") as
        | { session: Record<string, unknown> }
        | undefined
    )?.session["turn_detection"] as Record<string, unknown> | undefined;
    expect(td?.["create_response"]).toBe(true);
    expect(td?.["interrupt_response"]).toBe(false);
  });

  it("uses custom model and voice in session.update", async () => {
    const { received } = await connectedBridge({ model: "glm-realtime", voice: "xiaoxiao" });
    const su = received.find((m) => m["type"] === "session.update") as
      | { session: Record<string, unknown> }
      | undefined;
    expect(su?.session["model"]).toBe("glm-realtime");
    expect(su?.session["voice"]).toBe("xiaoxiao");
  });

  // ── server event handling ─────────────────────────────────────────────────────

  it("surfaces a failed response.done via onError", async () => {
    const onError = anyMock();
    const { server } = await connectedBridge({ onError });
    serverSend(server, {
      type: "response.done",
      response: { status: "failed", status_details: { error: { message: "content filtered" } } },
    });
    await wait();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("content filtered") }),
    );
  });

  it("does not call onError for a completed response.done", async () => {
    const onError = anyMock();
    const { server } = await connectedBridge({ onError });
    serverSend(server, { type: "response.done", response: { status: "completed" } });
    await wait();
    expect(onError).not.toHaveBeenCalled();
  });

  it("clears audio on response.cancelled", async () => {
    const onClearAudio = voidMock();
    const { server } = await connectedBridge({ onClearAudio });
    serverSend(server, { type: "response.cancelled" });
    await wait();
    expect(onClearAudio).toHaveBeenCalled();
  });

  it("clears audio on speech_started for barge-in", async () => {
    const onClearAudio = voidMock();
    const { server } = await connectedBridge({ onClearAudio });
    serverSend(server, { type: "input_audio_buffer.speech_started" });
    await wait();
    expect(onClearAudio).toHaveBeenCalled();
  });

  it("does not clear audio on speech_started when interrupt is disabled", async () => {
    const onClearAudio = voidMock();
    const { server } = await connectedBridge({
      interruptResponseOnInputAudio: false,
      onClearAudio,
    });
    serverSend(server, { type: "input_audio_buffer.speech_started" });
    await wait();
    expect(onClearAudio).not.toHaveBeenCalled();
  });

  it("forwards a final user transcript", async () => {
    const onTranscript = anyMock();
    const { server } = await connectedBridge({ onTranscript });
    serverSend(server, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "你好",
    });
    await wait();
    expect(onTranscript).toHaveBeenCalledWith("user", "你好", true);
  });

  it("forwards a non-final assistant transcript delta", async () => {
    const onTranscript = anyMock();
    const { server } = await connectedBridge({ onTranscript });
    serverSend(server, { type: "response.audio_transcript.delta", delta: "嗨" });
    await wait();
    expect(onTranscript).toHaveBeenCalledWith("assistant", "嗨", false);
  });

  it("forwards a final assistant transcript", async () => {
    const onTranscript = anyMock();
    const { server } = await connectedBridge({ onTranscript });
    serverSend(server, {
      type: "response.audio_transcript.done",
      transcript: "嗨，有什么可以帮你",
    });
    await wait();
    expect(onTranscript).toHaveBeenCalledWith("assistant", "嗨，有什么可以帮你", true);
  });

  it("ignores a function_call done missing call_id or name", async () => {
    const onToolCall = anyMock();
    const { server } = await connectedBridge({ onToolCall });
    serverSend(server, {
      type: "response.function_call_arguments.done",
      name: "f",
      arguments: "{}",
    }); // missing call_id
    serverSend(server, {
      type: "response.function_call_arguments.done",
      call_id: "c",
      arguments: "{}",
    }); // missing name
    await wait();
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("defaults tool args to {} on invalid JSON arguments", async () => {
    const onToolCall = anyMock();
    const { server } = await connectedBridge({ onToolCall });
    serverSend(server, {
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "f",
      arguments: "{not json",
    });
    await wait();
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ args: {} }));
  });

  it("falls back itemId to callId when item_id is absent", async () => {
    const onToolCall = anyMock();
    const { server } = await connectedBridge({ onToolCall });
    serverSend(server, {
      type: "response.function_call_arguments.done",
      call_id: "c2",
      name: "f",
      arguments: "{}",
    });
    await wait();
    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "c2", callId: "c2" }),
    );
  });

  // ── client send paths ─────────────────────────────────────────────────────────

  it("sendUserMessage sends conversation.item.create then response.create", async () => {
    const { bridge, received } = await connectedBridge();
    bridge.sendUserMessage?.("hello there");
    await wait();
    const item = received.find(
      (m) =>
        m["type"] === "conversation.item.create" &&
        (m["item"] as Record<string, unknown> | undefined)?.["role"] === "user",
    ) as { item: { content: { text: string }[] } } | undefined;
    expect(item?.item.content[0]?.text).toBe("hello there");
    expect(received.some((m) => m["type"] === "response.create")).toBe(true);
  });

  it("submitToolResult stringifies object results then requests a response", async () => {
    const { bridge, received } = await connectedBridge();
    bridge.submitToolResult?.("call-7", { ok: true });
    await wait();
    const out = received.find(
      (m) =>
        m["type"] === "conversation.item.create" &&
        (m["item"] as Record<string, unknown> | undefined)?.["type"] === "function_call_output",
    ) as { item: { call_id: string; output: string } } | undefined;
    expect(out?.item.call_id).toBe("call-7");
    expect(out?.item.output).toBe('{"ok":true}');
    const outIdx = received.indexOf(out as unknown as Record<string, unknown>);
    expect(received.slice(outIdx).some((m) => m["type"] === "response.create")).toBe(true);
  });

  it("submitToolResult forwards a string result unchanged", async () => {
    const { bridge, received } = await connectedBridge();
    bridge.submitToolResult?.("call-8", "plain text");
    await wait();
    const out = received.find(
      (m) =>
        m["type"] === "conversation.item.create" &&
        (m["item"] as Record<string, unknown> | undefined)?.["type"] === "function_call_output",
    ) as { item: { output: string } } | undefined;
    expect(out?.item.output).toBe("plain text");
  });

  it("does not send audio or barge-in before ready (no socket)", async () => {
    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
    });
    expect(() => bridge.sendAudio(Buffer.alloc(10))).not.toThrow();
    expect(() => bridge.handleBargeIn?.()).not.toThrow();
    expect(bridge.isConnected()).toBe(false);
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────────

  it("invokes onReady once after the handshake", async () => {
    const onReady = voidMock();
    await connectedBridge({ onReady });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("emits client and server events via onEvent", async () => {
    const onEvent = anyMock();
    await connectedBridge({ onEvent });
    expect(onEvent).toHaveBeenCalledWith({ direction: "server", type: "session.created" });
    expect(onEvent).toHaveBeenCalledWith({ direction: "client", type: "session.update" });
  });

  it("close() reports completed and flips isConnected", async () => {
    const onClose = anyMock();
    const { bridge } = await connectedBridge({ onClose });
    expect(bridge.isConnected()).toBe(true);
    bridge.close();
    expect(onClose).toHaveBeenCalledWith("completed");
    expect(bridge.isConnected()).toBe(false);
  });

  it("treats a clean 1000 close after ready as completed", async () => {
    const onClose = anyMock();
    const { server } = await connectedBridge({ onClose });
    server.lastConn?.close(1000);
    await wait(40);
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("treats an abnormal close code as error", async () => {
    const onClose = anyMock();
    const { server } = await connectedBridge({ onClose });
    server.lastConn?.close(1011);
    await wait(40);
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("treats a pre-ready close as error", async () => {
    const server = await startFakeServer();
    servers.push(server);
    const onClose = anyMock();
    const connectionReady = new Promise<void>((res) => {
      server.wss.once("connection", () => res());
    });
    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
      onClose,
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });
    void bridge.connect();
    await connectionReady;
    // Even a clean 1000 code counts as an error before the handshake completes.
    server.lastConn?.close(1000);
    await wait(40);
    expect(onClose).toHaveBeenCalledWith("error");
  });

  // ── connect failures ──────────────────────────────────────────────────────────

  it("rejects connect and surfaces a server error event", async () => {
    const server = await startFakeServer();
    servers.push(server);
    const onError = anyMock();
    const connectionReady = new Promise<void>((res) => {
      server.wss.once("connection", () => res());
    });
    const bridge = makeBridge({
      apiKey: "key",
      onAudio: audioMock(),
      onClearAudio: voidMock(),
      onError,
      _testEndpoint: `ws://127.0.0.1:${server.port}`,
    });
    const connectPromise = bridge.connect();
    await connectionReady;
    serverSend(server, { type: "error", error: { message: "bad params", code: "1002" } });
    await expect(connectPromise).rejects.toThrow(/bad params/);
    expect(onError).toHaveBeenCalled();
  });

  it("rejects connect with the HTTP status on unexpected-response", async () => {
    const wss = new WebSocketServer({ port: 0, verifyClient: () => false });
    const port = await new Promise<number>((res, rej) => {
      wss.on("listening", () => {
        const addr = wss.address();
        if (!addr || typeof addr === "string") {
          rej(new Error("bad address"));
          return;
        }
        res(addr.port);
      });
      wss.on("error", rej);
    });
    try {
      const onError = anyMock();
      const bridge = makeBridge({
        apiKey: "key",
        onAudio: audioMock(),
        onClearAudio: voidMock(),
        onError,
        _testEndpoint: `ws://127.0.0.1:${port}`,
      });
      await expect(bridge.connect()).rejects.toThrow(/HTTP 401/);
      expect(onError).toHaveBeenCalled();
    } finally {
      await new Promise<void>((res) => wss.close(() => res()));
    }
  });

  it("rejects connect and closes when the handshake times out", async () => {
    const server = await startFakeServer();
    servers.push(server);
    const onClose = anyMock();
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({
        apiKey: "key",
        onAudio: audioMock(),
        onClearAudio: voidMock(),
        onClose,
        _testEndpoint: `ws://127.0.0.1:${server.port}`,
      });
      // connectTimer is armed synchronously inside connect(), independent of the
      // socket opening — advancing past it fires the timeout path.
      const connectPromise = bridge.connect();
      const assertion = expect(connectPromise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(onClose).toHaveBeenCalledWith("error");
    } finally {
      vi.useRealTimers();
    }
  });
});
