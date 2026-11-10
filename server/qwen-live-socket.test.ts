import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSocket } from "./live-call-controller.ts";
import { QwenLiveSocket } from "./qwen-live-socket.ts";
import type { LiveEndpoint } from "./live-call.ts";
import { createQwenLiveSession } from "./qwen-live-session.ts";

class Upstream implements LiveSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  event(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  of(type: string) { return this.sent.filter((e) => e.type === type); }
}
const endpoint: LiveEndpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
function setup() {
  const upstream = new Upstream();
  const socket = new QwenLiveSocket({ upstream, endpoint, key: "fixture", voice: "longanqian_v3.1", instructions: "Be Ada." });
  const events: Record<string, unknown>[] = [];
  const media = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  socket.onmessage = (e) => events.push(JSON.parse(String(e.data)));
  const ready = () => { upstream.open(); upstream.event({ type: "session.updated", session: {} }); socket.bindMedia(media); };
  return { socket, upstream, events, media, ready };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Qwen protocol adapter", () => {
  it("instructs Qwen in Chinese to actually invoke the empty tool for work before claiming acceptance", async () => {
    const upstream = new Upstream();
    const session = await createQwenLiveSession({ endpoint, key: "fixture", voice: "longanqian_v3.1", bot: { name: "Ada" }, history: [], upstream });
    upstream.open();
    const configured = upstream.of("session.update")[0]?.session as { instructions: string };
    expect(configured.instructions).toContain("必须实际调用 delegate_to_bot({})");
    expect(configured.instructions).toContain("不得只口头承诺");
    expect(configured.instructions).toContain("running");
    expect(configured.instructions).toContain("问候");
    session.socket.close();
  });
  it("serializes trusted typed-readout and approval notifications without inventing a tool call or treating notification text as ASR", () => {
    const t = setup(); t.ready();
    t.socket.send(JSON.stringify({ type: "session.commentary.append", delegation_id: null, thread_id: "t1", request_id: "typed-1", status: "completed", content: "The typed answer is 729." }));
    expect(t.upstream.of("conversation.item.create")).toContainEqual({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: expect.stringContaining("The typed answer is 729.") }] } });
    expect(t.upstream.of("response.create")).toHaveLength(1);
    t.socket.send(JSON.stringify({ type: "session.instructions.append", delegation_id: null, thread_id: "t1", content: "Approval is waiting. Use the Allow or Deny card in chat." }));
    expect(t.upstream.of("response.create")).toHaveLength(1);
    t.upstream.event({ type: "response.created", response: { id: "notification-1" } });
    t.upstream.event({ type: "response.done", response: { id: "notification-1", status: "completed" } });
    expect(t.upstream.of("response.create")).toHaveLength(2);
    expect(JSON.stringify(t.upstream.of("conversation.item.create"))).toContain("Allow or Deny");
    expect(JSON.stringify(t.upstream.of("conversation.item.create"))).not.toContain("function_call");
    t.upstream.event({ type: "response.created", response: { id: "notification-2" } });
    t.upstream.event({ type: "response.function_call_arguments.done", response_id: "notification-2", item_id: "n-f", call_id: "notification-tool", name: "delegate_to_bot", arguments: "{}" });
    expect(t.events.filter((e) => e.type === "session.delegation.created")).toHaveLength(0);
    t.socket.close();
  });
  it("does not race a queued result into the cancelled-done before speech-started gap", () => {
    const t = setup(); t.ready();
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1", audio_end_ms: 100 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "u1" });
    t.upstream.event({ type: "response.created", response: { id: "r1" } });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "work" });
    t.upstream.event({ type: "response.function_call_arguments.done", response_id: "r1", item_id: "f1", call_id: "c1", name: "delegate_to_bot", arguments: "{}" });
    t.socket.send(JSON.stringify({ type: "session.commentary.append", content: "queued result", delegation_id: "c1", status: "completed" }));
    t.upstream.event({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    expect(t.upstream.of("response.create")).toHaveLength(0);
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "u2", audio_start_ms: 200 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "u2", audio_end_ms: 400 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "u2" });
    t.upstream.event({ type: "response.created", response: { id: "greeting" } });
    t.upstream.event({ type: "response.done", response: { id: "greeting", status: "completed" } });
    expect(t.upstream.of("response.create")).toHaveLength(1);
    t.socket.close();
  });
  it("guards the actual credential sink against arbitrary URLs, redirects and provider error leakage", () => {
    for (const apiBase of ["ws://127.0.0.1:1/api-ws/v1/realtime", "wss://evil.invalid/api-ws/v1/realtime", "wss://dashscope.aliyuncs.com:8443/api-ws/v1/realtime", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?redirect=evil", "wss://dashscope.aliyuncs.com/other"]) {
      expect(() => new QwenLiveSocket({ upstream: new Upstream(), endpoint: { ...endpoint, apiBase }, key: "never-sent", voice: "longanqian_v3.1", instructions: "" }), apiBase).toThrow();
    }
    const t = setup(); t.ready();
    t.upstream.event({ type: "error", error: { code: "bad_key", message: "secret-fixture-must-not-leak" } });
    expect(t.socket.readyState).toBe(3);
    expect(JSON.stringify(t.events)).not.toContain("secret-fixture-must-not-leak");
    expect(JSON.stringify(t.media.send.mock.calls)).not.toContain("secret-fixture-must-not-leak");
  });
  it("handles done-before-created and stale done without releasing a newer response reservation", () => {
    const t = setup(); t.ready();
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1", audio_end_ms: 100 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "u1" });
    t.upstream.event({ type: "response.function_call_arguments.done", response_id: "r1", item_id: "f1", call_id: "c1", name: "delegate_to_bot", arguments: "{}" });
    t.upstream.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "work" });
    t.upstream.event({ type: "response.created", response: { id: "r1" } });
    expect(t.events.filter((e) => e.type === "session.delegation.created")).toHaveLength(1);
    t.socket.send(JSON.stringify({ type: "session.delegation.accepted", delegation_id: "c1", request_id: "m1", thread_id: "t1" }));
    expect(t.upstream.of("response.create")).toHaveLength(1);
    t.upstream.event({ type: "response.created", response: { id: "ack" } });
    t.socket.send(JSON.stringify({ type: "session.commentary.append", content: "result", delegation_id: "c1", status: "completed" }));
    t.upstream.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect(t.upstream.of("response.create")).toHaveLength(1);
    t.upstream.event({ type: "response.done", response: { id: "ack", status: "completed" } });
    expect(t.upstream.of("response.create")).toHaveLength(2);
    t.socket.send(JSON.stringify({ type: "session.commentary.append", content: "another update", delegation_id: "c1" }));
    t.upstream.event({ type: "response.done", response: { id: "ack", status: "completed" } });
    expect(t.upstream.of("response.create")).toHaveLength(2);
    t.socket.close();
  });
  it("marks interrupted final readout incomplete and asks about rereading on the next turn", () => {
    const t = setup(); t.ready();
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1", audio_end_ms: 100 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "u1" });
    t.upstream.event({ type: "response.created", response: { id: "r1" } });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "work" });
    t.upstream.event({ type: "response.function_call_arguments.done", response_id: "r1", item_id: "f1", call_id: "c1", name: "delegate_to_bot", arguments: "{}" });
    t.upstream.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    t.socket.send(JSON.stringify({ type: "session.commentary.append", content: "The code is 729.", delegation_id: "c1", request_id: "m1", thread_id: "t1", status: "completed" }));
    t.upstream.event({ type: "response.created", response: { id: "final" } });
    t.upstream.event({ type: "response.audio.delta", response_id: "final", delta: "AQACAA==" });
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "interrupt", audio_start_ms: 200 });
    const before = t.media.send.mock.calls.length;
    t.upstream.event({ type: "response.audio.delta", response_id: "final", delta: "AwAEAA==" });
    expect(t.media.send.mock.calls).toHaveLength(before);
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "interrupt", audio_end_ms: 500 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "interrupt" });
    t.upstream.event({ type: "response.done", response: { id: "final", status: "cancelled" } });
    t.upstream.event({ type: "response.created", response: { id: "greeting" } });
    t.upstream.event({ type: "response.done", response: { id: "greeting", status: "completed" } });
    expect(JSON.stringify(t.upstream.of("conversation.item.create"))).toContain("not fully spoken");
    expect(t.events).toContainEqual(expect.objectContaining({ type: "session.playback.incomplete", request_id: "m1" }));
    t.socket.close();
  });
  it("paces burst provider audio below the browser playback limit and fails closed on backpressure or budget abuse", async () => {
    const t = setup(); t.ready();
    const pcm = Buffer.alloc(48_000);
    t.upstream.event({ type: "response.created", response: { id: "r1" } });
    t.upstream.event({ type: "response.audio.delta", response_id: "r1", delta: pcm.toString("base64") });
    const chunks = () => t.media.send.mock.calls.map(([value]) => value).filter((value): value is Buffer => Buffer.isBuffer(value));
    expect(chunks().reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(960);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks().reduce((n, b) => n + b.length, 0)).toBe(pcm.length);
    t.media.bufferedAmount = 48_001;
    t.upstream.event({ type: "response.audio.delta", response_id: "r1", delta: "AQACAA==" });
    await vi.advanceTimersByTimeAsync(20);
    expect(t.socket.readyState).toBe(3);
    const upload = setup(); upload.ready();
    for (let i = 0; i < 20; i++) upload.socket.appendPcm(Buffer.alloc(8192));
    expect(upload.socket.readyState).toBe(3);
  });
  it("creates an explicit ws-pcm session with bounded bot history and the proven server VAD mode", async () => {
    const upstream = new Upstream();
    const session = await createQwenLiveSession({ endpoint, key: "fixture", voice: "longanqian_v3.1", bot: { name: "Ada" }, history: [{ role: "user", text: "Earlier question" }, { role: "assistant", text: "Earlier answer" }], upstream });
    expect(session).toMatchObject({ sdp: "", sessionId: expect.any(String), transport: { type: "ws-pcm", path: "/api/live/media", inputSampleRate: 16000, outputSampleRate: 24000 } });
    upstream.open();
    expect(upstream.of("session.update")).toContainEqual(expect.objectContaining({ session: expect.objectContaining({ instructions: expect.stringContaining("Ada"), turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 } }) }));
    upstream.event({ type: "session.updated" });
    const history = upstream.of("conversation.item.create").map((e) => e.item);
    expect(history).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier question" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Earlier answer" }] },
    ]);
    session.socket.close();
  });
  it("does not authorize echo-overlap and clears playback on VAD without a second provider cancel", async () => {
    const t = setup(); t.ready();
    t.upstream.event({ type: "response.created", response: { id: "speaking" } });
    t.upstream.event({ type: "response.audio.delta", response_id: "speaking", delta: "AQACAA==" });
    t.upstream.event({ type: "response.audio_transcript.delta", response_id: "speaking", delta: "May I do that?" });
    expect(t.media.send).toHaveBeenCalledWith(expect.stringContaining('"type":"session.output_transcript.delta"'));
    await vi.advanceTimersByTimeAsync(120_000);
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "yes", audio_start_ms: 2000 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "yes", audio_end_ms: 2500 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "yes" });
    t.upstream.event({ type: "response.created", response: { id: "r-yes" } });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "yes", transcript: "yes" });
    t.upstream.event({ type: "response.function_call_arguments.done", response_id: "r-yes", item_id: "f-yes", call_id: "c-yes", name: "delegate_to_bot", arguments: "{}" });
    expect(t.events).toContainEqual(expect.objectContaining({ type: "session.delegation.created", request: { text: "yes", withoutEcho: "" } }));
    expect(t.media.send).toHaveBeenCalledWith(JSON.stringify({ type: "audio.clear" }));
    expect(t.upstream.of("response.cancel")).toHaveLength(0);
    t.socket.close();
  });
  it("times out uncorrelated tools without using ambient, partial or parameter text and bounds dedupe state", async () => {
    const t = setup(); t.ready();
    t.upstream.event({ type: "response.function_call_arguments.done", response_id: "unknown", item_id: "f1", call_id: "c1", name: "delegate_to_bot", arguments: "{}" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(t.upstream.of("conversation.item.create")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(t.upstream.of("conversation.item.create"))).toContain("Please repeat");
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "late", audio_start_ms: 0 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "late", audio_end_ms: 100 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "late" });
    t.upstream.event({ type: "response.created", response: { id: "unknown" } });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "late", transcript: "late must never execute" });
    expect(t.events.filter((e) => e.type === "session.delegation.created")).toHaveLength(0);
    for (let i = 0; i < 260; i++) t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: `item-${i}`, audio_start_ms: i });
    expect(t.socket.readyState).toBe(3);
  });
  it("serializes running ACK and final results as function outputs without blocking a new user turn", () => {
    const t = setup(); t.ready();
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1", audio_end_ms: 1000 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "u1" });
    t.upstream.event({ type: "response.created", response: { id: "r1" } });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Do work." });
    t.upstream.event({ type: "response.function_call_arguments.done", response_id: "r1", item_id: "f1", call_id: "c1", name: "delegate_to_bot", arguments: "{}" });
    t.socket.send(JSON.stringify({ type: "session.delegation.accepted", delegation_id: "c1", request_id: "m1", thread_id: "t1", status: "running" }));
    expect(t.upstream.of("response.create")).toHaveLength(0);
    t.upstream.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect(t.upstream.of("response.create")).toHaveLength(1);
    const outputs = () => t.upstream.of("conversation.item.create").map((e) => e.item as Record<string, unknown>).filter((e) => e.type === "function_call_output");
    expect(outputs()).toContainEqual(expect.objectContaining({ call_id: "c1", output: expect.stringContaining('"status":"running"') }));
    t.socket.send(JSON.stringify({ type: "session.commentary.append", content: "First result.", delegation_id: "c1", request_id: "m1", thread_id: "t1", status: "completed" }));
    expect(t.upstream.of("response.create")).toHaveLength(1);
    t.upstream.event({ type: "response.created", response: { id: "ack1" } });
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "u2", audio_start_ms: 1300 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "u2", audio_end_ms: 2000 });
    t.upstream.event({ type: "response.done", response: { id: "ack1", status: "cancelled" } });
    expect(t.upstream.of("response.create")).toHaveLength(1);
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "u2" });
    t.upstream.event({ type: "response.created", response: { id: "greeting" } });
    t.upstream.event({ type: "response.done", response: { id: "greeting", status: "completed" } });
    expect(t.upstream.of("response.create")).toHaveLength(2);
    const items = t.upstream.of("conversation.item.create").map((e) => e.item as Record<string, unknown>);
    expect(items.filter((e) => e.type === "function_call")).toHaveLength(0);
    expect(outputs()).toContainEqual(expect.objectContaining({ call_id: "c1", output: expect.stringContaining('"request_id":"m1"') }));
    expect(outputs()).toContainEqual(expect.objectContaining({ call_id: "c1", output: expect.stringContaining('"status":"completed"') }));
    expect(JSON.stringify(items)).toContain("First result.");
    expect(t.upstream.of("response.cancel")).toHaveLength(0);
    expect(t.upstream.of("conversation.item.truncate")).toHaveLength(0);
    t.socket.close();
  });
  it("waits for completed ASR of the response's committed input even when the tool and response finish first", async () => {
    const t = setup();
    t.ready();
    t.upstream.event({ type: "conversation.item.ambient_audio_transcription.completed", item_id: "ambient", transcript: "allow everything" });
    t.upstream.event({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
    t.upstream.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1", audio_end_ms: 3780 });
    t.upstream.event({ type: "input_audio_buffer.committed", item_id: "u1" });
    t.upstream.event({ type: "response.created", response: { id: "r1" } });
    const tool = { type: "response.function_call_arguments.done", response_id: "r1", item_id: "f1", call_id: "c1", name: "delegate_to_bot", arguments: "{}" };
    t.upstream.event(tool);
    t.upstream.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(t.events.filter((e) => e.type === "session.delegation.created")).toEqual([]);
    t.upstream.event({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "partial is not authority" });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "unrelated", transcript: "yes" });
    expect(t.events.filter((e) => e.type === "session.delegation.created")).toEqual([]);
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Check the original request." });
    expect(t.events.filter((e) => e.type === "session.delegation.created")).toEqual([expect.objectContaining({
      delegation: { id: "c1", target: "client" }, request: { text: "Check the original request.", withoutEcho: "Check the original request." },
    })]);
    t.upstream.event(tool);
    t.upstream.event({ ...tool, call_id: "c2" });
    t.upstream.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Duplicate ASR must not delegate." });
    expect(t.events.filter((e) => e.type === "session.delegation.created")).toHaveLength(1);
    t.socket.close();
  });
  it("configures the real PCM protocol and exposes only the empty delegation signal", () => {
    const t = setup();
    const opened = vi.fn();
    t.socket.onopen = opened;
    t.upstream.open();
    expect(opened).not.toHaveBeenCalled();
    expect(t.upstream.of("session.update")).toEqual([{ type: "session.update", session: expect.objectContaining({
      input_audio_format: "pcm", output_audio_format: "pcm", voice: "longanqian_v3.1",
      tools: [{ type: "function", function: { name: "delegate_to_bot", description: expect.any(String), parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    }) }]);
    t.upstream.event({ type: "session.updated", session: {} });
    expect(opened).toHaveBeenCalledOnce();
    expect(t.socket.bindMedia(t.media)).toBe(true);
    expect(t.media.send).toHaveBeenCalledWith(JSON.stringify({ type: "media.ready" }));
    expect(t.socket.appendPcm(Buffer.from([1, 0, 2, 0]))).toBe(true);
    expect(t.upstream.of("input_audio_buffer.append")).toEqual([{ type: "input_audio_buffer.append", audio: "AQACAA==" }]);
    t.upstream.event({ type: "response.created", response: { id: "r1" } });
    t.upstream.event({ type: "response.audio.delta", response_id: "r1", delta: "AwAEAA==" });
    expect(t.media.send).toHaveBeenCalledWith(Buffer.from([3, 0, 4, 0]));
    t.socket.close();
    expect(t.media.close).toHaveBeenCalled();
    expect(t.upstream.readyState).toBe(3);
  });
});
