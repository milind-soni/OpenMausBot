import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { Store } from "./store.ts";
import { LiveCallController, type LiveSocket, type LiveSendResult, type LiveCallDeps } from "./live-call-controller.ts";
import { createQwenLiveSession } from "./qwen-live-session.ts";
import { createLiveMediaRoutes } from "./routes/live-media.ts";
import { createLiveRoutes } from "./routes/live.ts";
import { createUpgrades } from "./routes/upgrades.ts";
import { dispatchRoutes } from "./routes/table.ts";
import { json, readBody } from "./harness/http.ts";
import type { LiveEndpoint } from "./live-call.ts";

class Provider implements LiveSocket {
  readyState = 0;
  onopen: LiveSocket["onopen"] = null; onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null; onerror: LiveSocket["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); this.event({ type: "session.updated" }); }
  event(e: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(e) }); }
  outputs() { return this.sent.filter((e) => e.type === "conversation.item.create").map((e) => e.item as Record<string, unknown>).filter((e) => e.type === "function_call_output"); }
}

it("runs PCM through the actual routes, adapter, controller and isolated store: accepted ACK, long-task greeting, original-request final, hangup", async () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Qwen fixture" });
  const provider = new Provider();
  const endpoint: LiveEndpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
  let accept!: (receipt: LiveSendResult) => void;
  let requestId = "";
  const send = vi.fn(async (input: Parameters<LiveCallDeps["send"]>[0]) => {
    const message = store.appendMessage(input.threadId, { role: "user", kind: "text", text: input.text, via: "call", callId: input.callId });
    requestId = message.id;
    return new Promise<LiveSendResult>((resolve) => { accept = resolve; });
  });
  const calls = new LiveCallController({ store, send, respond: async () => ({ ok: true }), queued: () => false, activity: () => "working", broadcast: () => {},
    settings: () => ({ provider: "qwen", endpoint, key: "isolated-fixture", voice: "marin", qwenVoice: "longanqian_v3.1", readTypedReplies: true, idleMinutes: 5 }),
    azureRefusal: () => null, createSession: (input) => createQwenLiveSession({ ...input, bot: { name: bot.name }, history: [], upstream: provider }),
    openSocket: () => { throw new Error("must use explicit adapter"); }, attachUrl: () => "unused", speakable: (text) => [text], log: () => {},
  });
  const upgrades = createUpgrades();
  const media = createLiveMediaRoutes({ upgrades, calls });
  const routes = [media, createLiveRoutes({ calls, resolveTarget: () => ({ botId: bot.id, botName: bot.name, threadId: bot.threadId }), settings: () => ({ provider: "qwen", configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 }), saveSettings: async () => { throw new Error("unused"); } })];
  const handle = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
  };
  const server = createServer(handle); upgrades.attach(server, handle);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let socket: WebSocket | undefined;
  try {
    const res = await fetch(`${base}/api/live/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botId: bot.id, client: "web", sdp: "native-offer-discarded", transports: ["ws-pcm"] }) });
    expect(res.status).toBe(201);
    const session = await res.json() as { call: { callId: string }; transport: { type: string; path: string } };
    expect(session.transport.type).toBe("ws-pcm");
    provider.open();
    socket = new WebSocket(`${base.replace(/^http/, "ws")}${session.transport.path}`);
    const received: Array<string | Buffer> = [];
    socket.on("message", (data, binary) => received.push(binary ? Buffer.from(data as Buffer) : data.toString()));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "bind", callId: session.call.callId }));
    await vi.waitFor(() => expect(received).toContain(JSON.stringify({ type: "media.ready" })));
    socket.send(Buffer.from([1, 0, 2, 0]));
    await vi.waitFor(() => expect(provider.sent).toContainEqual({ type: "input_audio_buffer.append", audio: "AQACAA==" }));
    provider.event({ type: "input_audio_buffer.speech_started", item_id: "spoken", audio_start_ms: 0 });
    provider.event({ type: "input_audio_buffer.speech_stopped", item_id: "spoken", audio_end_ms: 1000 });
    provider.event({ type: "input_audio_buffer.committed", item_id: "spoken" });
    provider.event({ type: "response.created", response: { id: "delegating" } });
    provider.event({ type: "response.function_call_arguments.done", response_id: "delegating", item_id: "function-item", call_id: "original-call", name: "delegate_to_bot", arguments: "{}" });
    provider.event({ type: "response.done", response: { id: "delegating", status: "completed" } });
    provider.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "spoken", transcript: "Run the isolated long task." });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === requestId)?.text).toBe("Run the isolated long task.");
    expect(provider.outputs()).toHaveLength(0);
    accept({ kind: "started", messageId: requestId });
    await vi.waitFor(() => expect(provider.outputs()).toHaveLength(1));
    expect(provider.outputs()[0]).toMatchObject({ call_id: "original-call", output: expect.stringContaining('"status":"running"') });
    provider.event({ type: "response.created", response: { id: "ack" } });
    provider.event({ type: "response.done", response: { id: "ack", status: "completed" } });
    provider.event({ type: "input_audio_buffer.speech_started", item_id: "hello", audio_start_ms: 2000 });
    provider.event({ type: "input_audio_buffer.speech_stopped", item_id: "hello", audio_end_ms: 3000 });
    provider.event({ type: "input_audio_buffer.committed", item_id: "hello" });
    provider.event({ type: "response.created", response: { id: "greeting" } });
    provider.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "hello", transcript: "Hello." });
    provider.event({ type: "response.audio.delta", response_id: "greeting", delta: "AwAEAA==" });
    provider.event({ type: "response.done", response: { id: "greeting", status: "completed" } });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "The isolated result is 729.", turnTerminal: true, requestMessageId: requestId });
    await vi.waitFor(() => expect(provider.outputs()).toHaveLength(2));
    expect(provider.outputs()[1]).toMatchObject({ call_id: "original-call", output: expect.stringContaining('"status":"completed"') });
    expect(String(provider.outputs()[1]?.output)).toContain("The isolated result is 729.");
    expect(String(provider.outputs()[1]?.output)).toContain(requestId);
    await vi.waitFor(() => expect(received.some((value) => Buffer.isBuffer(value))).toBe(true));
    const closed = once(socket, "close"); socket.send(JSON.stringify({ type: "hangup" })); await closed;
    expect(calls.current()).toBeNull();
    expect(store.messagesFor(bot.threadId).some((m) => m.text === "The isolated result is 729.")).toBe(true);
  } finally {
    socket?.terminate(); media.close(); upgrades.close(); await calls.shutdown();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 10_000);
