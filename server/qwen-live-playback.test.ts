import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSocket } from "./live-call-controller.ts";
import { QwenLiveSocket } from "./qwen-live-socket.ts";

class Provider implements LiveSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  event(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
function fixture(playbackFlow?: "credit-v1") {
  const provider = new Provider();
  const socket = new QwenLiveSocket({ upstream: provider, endpoint: { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" }, key: "test-only", voice: "longanqian_v3.1", instructions: "fixture" });
  const media = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  const events: Record<string, unknown>[] = [];
  socket.onmessage = e => events.push(JSON.parse(String(e.data)));
  provider.readyState = 1; provider.onopen?.({}); provider.event({ type: "session.updated" }); socket.bindMedia(media, playbackFlow);
  const delivered = () => media.send.mock.calls.reduce((sum, [value]) => sum + (Buffer.isBuffer(value) ? value.length : 0), 0);
  return { socket, provider, media, delivered, events };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("plays a 30-second provider burst without dropping the call or losing PCM", async () => {
  const f = fixture();
  f.provider.event({ type: "response.created", response: { id: "long" } });
  for (let i = 0; i < 75; i++) f.provider.event({ type: "response.audio.delta", response_id: "long", delta: Buffer.alloc(19_200, i).toString("base64") });
  expect(f.socket.readyState).toBe(1);
  expect(f.delivered()).toBeLessThanOrEqual(960);
  await vi.advanceTimersByTimeAsync(30_100);
  expect(f.delivered()).toBe(1_440_000);
  expect(f.socket.readyState).toBe(1);
  f.socket.close();
});

it("does not start the next readout until generated audio has drained", async () => {
  const f = fixture();
  const note = (text: string) => f.socket.send(JSON.stringify({ type: "session.commentary.append", delegation_id: null, thread_id: "t", content: text }));
  note("first"); f.provider.event({ type: "response.created", response: { id: "first" } });
  f.provider.event({ type: "response.audio.delta", response_id: "first", delta: Buffer.alloc(48_000).toString("base64") });
  note("second"); f.provider.event({ type: "response.done", response: { id: "first", status: "completed" } });
  expect(f.provider.sent.filter(e => e.type === "response.create")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_100);
  expect(f.provider.sent.filter(e => e.type === "response.create")).toHaveLength(2);
  f.socket.close();
});

it.each([undefined, "credit-v1"] as const)("marks an interrupted result incomplete after generation finishes with %s flow", playbackFlow => {
  const f = fixture(playbackFlow);
  try {
    f.socket.send(JSON.stringify({ type: "session.commentary.append", thread_id: "thread", request_id: "request", status: "completed", content: "The code is 729." }));
    f.provider.event({ type: "response.created", response: { id: "result" } });
    f.provider.event({ type: "response.audio.delta", response_id: "result", delta: Buffer.alloc(48_000).toString("base64") });
    f.provider.event({ type: "response.done", response: { id: "result", status: "completed" } });
    expect(f.delivered()).toBeLessThan(48_000);
    f.provider.event({ type: "input_audio_buffer.speech_started", item_id: "interruption", audio_start_ms: 100 });
    expect(f.events.filter(event => event.type === "session.playback.incomplete")).toEqual([
      { type: "session.playback.incomplete", request_id: "request", thread_id: "thread" },
    ]);
    f.provider.event({ type: "input_audio_buffer.speech_stopped", item_id: "interruption", audio_end_ms: 200 });
    f.provider.event({ type: "input_audio_buffer.committed", item_id: "interruption" });
    f.provider.event({ type: "response.created", response: { id: "greeting" } });
    f.provider.event({ type: "response.done", response: { id: "greeting", status: "completed" } });
    expect(JSON.stringify(f.provider.sent)).toContain("not fully spoken");
    f.provider.event({ type: "response.done", response: { id: "result", status: "cancelled" } });
    expect(f.events.filter(event => event.type === "session.playback.incomplete")).toHaveLength(1);
  } finally { f.socket.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])("retains a result until its last sent PCM is consumed, with done-before-last-send %s", async doneBeforeLastSend => {
  const f = fixture("credit-v1");
  try {
    expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" })).toBe(true);
    f.socket.send(JSON.stringify({ type: "session.commentary.append", thread_id: "thread", request_id: "request", status: "completed", content: "The code is 729." }));
    f.provider.event({ type: "response.created", response: { id: "result" } });
    f.provider.event({ type: "response.audio.delta", response_id: "result", delta: Buffer.alloc(1_920).toString("base64") });
    if (doneBeforeLastSend) f.provider.event({ type: "response.done", response: { id: "result", status: "completed" } });
    await vi.advanceTimersByTimeAsync(20);
    if (!doneBeforeLastSend) f.provider.event({ type: "response.done", response: { id: "result", status: "completed" } });
    expect(f.delivered()).toBe(1_920);
    expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 2, bytes: 960, contextState: "running" })).toBe(true);
    f.provider.event({ type: "input_audio_buffer.speech_started", item_id: "interruption", audio_start_ms: 100 });
    expect(f.events.filter(event => event.type === "session.playback.incomplete")).toEqual([
      { type: "session.playback.incomplete", request_id: "request", thread_id: "thread" },
    ]);
  } finally { f.socket.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

it("forgets a fully drained result and attributes a later interruption only to the queued result", async () => {
  const f = fixture("credit-v1");
  const note = (id: string) => f.socket.send(JSON.stringify({ type: "session.commentary.append", thread_id: "thread", request_id: id, status: "completed", content: id }));
  const generated = (id: string) => {
    f.provider.event({ type: "response.created", response: { id } });
    f.provider.event({ type: "response.audio.delta", response_id: id, delta: Buffer.alloc(48_000).toString("base64") });
    f.provider.event({ type: "response.done", response: { id, status: "completed" } });
  };
  try {
    note("first"); generated("first"); note("second");
    for (const seq of [1, 2]) {
      expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq, bytes: 24_000, contextState: "running" })).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(f.delivered()).toBe(48_000);
    expect(f.provider.sent.filter(event => event.type === "response.create")).toHaveLength(1);
    expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 3, bytes: 24_000, contextState: "running" })).toBe(true);
    expect(f.provider.sent.filter(event => event.type === "response.create")).toHaveLength(2);
    expect(f.events.filter(event => event.type === "session.playback.incomplete")).toHaveLength(0);
    generated("second");
    f.provider.event({ type: "input_audio_buffer.speech_started", item_id: "interruption", audio_start_ms: 2000 });
    expect(f.events.filter(event => event.type === "session.playback.incomplete")).toEqual([
      { type: "session.playback.incomplete", request_id: "second", thread_id: "thread" },
    ]);
  } finally { f.socket.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, "credit-v1"] as const)("does not mark a fully drained result incomplete on later speech with %s flow", async playbackFlow => {
  const f = fixture(playbackFlow);
  try {
    f.socket.send(JSON.stringify({ type: "session.commentary.append", thread_id: "thread", request_id: "request", status: "completed", content: "The code is 729." }));
    f.provider.event({ type: "response.created", response: { id: "result" } });
    f.provider.event({ type: "response.audio.delta", response_id: "result", delta: Buffer.alloc(960).toString("base64") });
    f.provider.event({ type: "response.done", response: { id: "result", status: "completed" } });
    if (playbackFlow) expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 1, bytes: 960, contextState: "running" })).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(f.delivered()).toBe(960);
    if (playbackFlow) expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 2, bytes: 960, contextState: "running" })).toBe(true);
    expect(f.socket.hasPendingMedia()).toBe(false);
    f.provider.event({ type: "input_audio_buffer.speech_started", item_id: "next-turn", audio_start_ms: 100 });
    expect(f.events.filter(event => event.type === "session.playback.incomplete")).toHaveLength(0);
    expect(JSON.stringify(f.provider.sent)).not.toContain("not fully spoken");
  } finally { f.socket.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a fixed redacted reason when an explicit output limit is exceeded", () => {
  const f = fixture();
  f.provider.event({ type: "response.created", response: { id: "abuse" } });
  for (let i = 0; i < 400 && f.socket.readyState !== 3; i++) f.provider.event({ type: "response.audio.delta", response_id: "abuse", delta: Buffer.alloc(19_200).toString("base64") });
  expect(f.socket.readyState).toBe(3);
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-output-audio-limit" } });
  expect(JSON.stringify(f.events)).not.toContain("test-only");
});

it("reports transport failure without exposing the upstream exception", () => {
  const f = fixture();
  f.provider.onerror?.({ message: "credential-bearing-error" });
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-provider-transport" } });
  expect(JSON.stringify(f.events)).not.toContain("credential-bearing");
  expect(f.socket.readyState).toBe(3);
});

it("reports an unsupported voice as its own reason without echoing the provider list", () => {
  const f = fixture();
  f.provider.event({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "Unsupported voice: 'longjing_v3.1'. Supported voices: longanqian, yuxiaoyun_v3.1.", param: "session.update" } });
  expect(f.socket.readyState).toBe(3);
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-provider-voice" } });
  expect(JSON.stringify(f.events)).not.toContain("longjing");
});

it("keeps the generic reason for other provider errors", () => {
  const f = fixture();
  f.provider.event({ type: "error", error: { type: "server_error", code: "internal_error", message: "boom" } });
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-provider-error" } });
});

it("records only the standard close code for an upstream failure", () => {
  const f = fixture();
  f.provider.onclose?.({ code: 1006, reason: "secret-bearing-provider-body-must-not-appear" });
  expect(f.socket.readyState).toBe(3);
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-provider-closed-1006" } });
  expect(JSON.stringify(f.events)).not.toContain("secret-bearing-provider");
});
