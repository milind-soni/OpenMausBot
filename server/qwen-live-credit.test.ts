import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSocket } from "./live-call-controller.ts";
import type { LivePlaybackCredit } from "../shared/wire.ts";
import { QwenLiveSocket } from "./qwen-live-socket.ts";
import { createQwenLiveSession } from "./qwen-live-session.ts";

class Provider implements LiveSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  event(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" } as const;
function fixture(flow: "credit-v1" | null = "credit-v1", ready = true) {
  const provider = new Provider();
  const socket = new QwenLiveSocket({ upstream: provider, endpoint, key: "test-only", voice: "longanqian_v3.1", instructions: "fixture" });
  const media = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  const events: Record<string, unknown>[] = [];
  socket.onmessage = e => events.push(JSON.parse(String(e.data)));
  socket.bindMedia(media, flow ?? undefined);
  const open = () => { provider.readyState = 1; provider.onopen?.({}); provider.event({ type: "session.updated" }); };
  if (ready) open();
  const chunks = () => media.send.mock.calls.map(([value]) => value).filter((value): value is Buffer => Buffer.isBuffer(value));
  const delivered = () => chunks().reduce((sum, chunk) => sum + chunk.length, 0);
  const audio = (bytes: number, id = "audio") => {
    provider.event({ type: "response.created", response: { id } });
    provider.event({ type: "response.audio.delta", response_id: id, delta: Buffer.alloc(bytes, 7).toString("base64") });
  };
  return { socket, provider, media, events, open, chunks, delivered, audio };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("advertises optional credit-v1 and acknowledges an early opt-in bind only after provider confirmation", async () => {
  const provider = new Provider();
  const session = await createQwenLiveSession({ endpoint, key: "test-only", voice: "longanqian_v3.1", bot: { name: "Fixture" }, history: [], upstream: provider });
  expect(session.transport).toEqual({ type: "ws-pcm", path: "/api/live/media", inputSampleRate: 16000, outputSampleRate: 24000, playbackFlow: "credit-v1" });
  session.socket.close();
  const f = fixture("credit-v1", false);
  expect(f.media.send).not.toHaveBeenCalled();
  f.open();
  expect(f.media.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
  expect(f.socket.bindMedia({ bufferedAmount: 0, send: vi.fn(), close: vi.fn() }, "credit-v1")).toBe(false);
  f.socket.close();
});

it("bounds the opted-in downlink by deduplicated credit without accelerating the 20ms PCM cadence", async () => {
  const f = fixture();
  f.audio(48_000);
  expect(f.delivered()).toBe(0);
  const credit = { type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" } as const;
  expect(f.socket.playbackCredit(credit)).toBe(true);
  expect(f.delivered()).toBe(960);
  expect(f.socket.playbackCredit(credit)).toBe(true);
  await vi.advanceTimersByTimeAsync(19);
  expect(f.delivered()).toBe(960);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.delivered()).toBe(1_920);
  await vi.advanceTimersByTimeAsync(980);
  expect(f.delivered()).toBe(24_000);
  expect(f.socket.readyState).toBe(1);
  expect(f.socket.playbackCredit(credit)).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.delivered()).toBe(24_000);
  expect(f.socket.playbackCredit({ ...credit, seq: 2 })).toBe(true);
  expect(f.delivered()).toBe(24_960);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.delivered()).toBe(48_000);
  expect(f.chunks().every(chunk => chunk.length <= 960)).toBe(true);
  f.socket.close();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["speech", "cancelled"])("isolates late credit by epoch after %s clear and never fast-sends across the clear", async cause => {
  const f = fixture();
  const credit = { type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" } as const;
  expect(f.socket.playbackCredit(credit)).toBe(true);
  f.audio(1_920);
  expect(f.delivered()).toBe(960);
  await vi.advanceTimersByTimeAsync(1);
  if (cause === "speech") f.provider.event({ type: "input_audio_buffer.speech_started", item_id: "u", audio_start_ms: 0 });
  else f.provider.event({ type: "response.done", response: { id: "audio", status: "cancelled" } });
  expect(f.media.send).toHaveBeenCalledWith(JSON.stringify({ type: "audio.clear", epoch: 1 }));
  f.provider.event({ type: "response.created", response: { id: "new-audio" } });
  f.provider.event({ type: "response.audio.delta", response_id: "new-audio", delta: Buffer.alloc(1_920, 9).toString("base64") });
  expect(f.socket.playbackCredit({ ...credit, seq: 999 })).toBe(true);
  expect(f.socket.playbackCredit({ ...credit, epoch: 2 })).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.delivered()).toBe(960);
  expect(f.socket.playbackCredit({ ...credit, epoch: 1, bytes: 960 })).toBe(true);
  expect(f.delivered()).toBe(960);
  await vi.advanceTimersByTimeAsync(18);
  expect(f.delivered()).toBe(1_920);
  expect(f.chunks().at(-1)?.equals(Buffer.alloc(960, 9))).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.delivered()).toBe(1_920);
  f.socket.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("ends only a queued, non-progressing credit flow after 60 seconds despite zero-byte state heartbeats", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(70_000);
  expect(f.socket.readyState).toBe(1);
  f.audio(1_920);
  for (let seq = 1; seq <= 5; seq++) {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq, bytes: 0, contextState: "suspended" })).toBe(true);
  }
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.socket.readyState).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.socket.readyState).toBe(3);
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-playback-stalled" } });
  expect(f.delivered()).toBe(0);
  expect(f.media.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the no-progress deadline on the last unconsumed playback window", async () => {
  const f = fixture();
  expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" })).toBe(true);
  f.audio(960);
  f.provider.event({ type: "response.done", response: { id: "audio", status: "completed" } });
  expect(f.delivered()).toBe(960);
  expect(f.socket.hasPendingMedia()).toBe(true);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 2, bytes: 0, contextState: "running" })).toBe(true);
  expect(f.socket.readyState).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.socket.readyState).toBe(3);
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-playback-stalled" } });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { bytes: -2 }, { bytes: 1 }, { bytes: 24_002 }, { bytes: NaN }, { bytes: Infinity }, { bytes: "960" },
  { epoch: -1 }, { epoch: 0.5 }, { epoch: 1_000_000_001 }, { seq: -1 }, { seq: 0.5 }, { seq: 1_000_000_001 },
  { contextState: "unknown" }, { contextState: "suspended", bytes: 2 }, { reason: "never-log-this" },
])("refuses invalid credit at the adapter boundary: %j", override => {
  const f = fixture();
  const credit = { type: "playback.credit", epoch: 0, seq: 1, bytes: 960, contextState: "running", ...override };
  expect(f.socket.playbackCredit(credit as LivePlaybackCredit)).toBe(false);
  expect(f.delivered()).toBe(0);
  f.socket.close();
});

it("refuses accumulated credit above 24000 even without queued audio, while legacy never opts in", () => {
  const f = fixture();
  const credit = { type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" } as const;
  expect(f.socket.playbackCredit(credit)).toBe(true);
  expect(f.socket.playbackCredit({ ...credit, seq: 2, bytes: 2 })).toBe(false);
  f.socket.close();
  const legacy = fixture(null);
  expect(legacy.media.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "media.ready" }));
  expect(legacy.socket.playbackCredit(credit)).toBe(false);
  legacy.audio(960);
  expect(legacy.delivered()).toBe(960);
  legacy.socket.close();
});

it("pauses outstanding credit on a suspended context and resumes in order without granting new bytes", async () => {
  const f = fixture();
  const credit = { type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" } as const;
  expect(f.socket.playbackCredit(credit)).toBe(true);
  f.audio(1_920);
  expect(f.delivered()).toBe(960);
  expect(f.socket.playbackCredit({ ...credit, seq: 2, bytes: 0, contextState: "suspended" })).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.delivered()).toBe(960);
  expect(f.socket.playbackCredit({ ...credit, seq: 3, bytes: 0 })).toBe(true);
  expect(f.delivered()).toBe(1_920);
  expect(f.socket.playbackCredit({ ...credit, seq: 4, bytes: 1_920 })).toBe(true);
  expect(f.socket.hasPendingMedia()).toBe(false);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(f.socket.readyState).toBe(1);
  f.socket.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("resets the stall deadline only when queued PCM actually drains", async () => {
  const f = fixture();
  f.audio(1_920);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 1, bytes: 960, contextState: "running" })).toBe(true);
  expect(f.delivered()).toBe(960);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(f.socket.readyState).toBe(1);
  expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 0, seq: 2, bytes: 0, contextState: "running" })).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.socket.readyState).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves the exact 120-second provider queue budget while credit is zero", () => {
  const f = fixture();
  for (let i = 0; i < 300; i++) f.audio(19_200);
  expect(f.socket.readyState).toBe(1);
  expect(f.delivered()).toBe(0);
  f.audio(2);
  expect(f.socket.readyState).toBe(3);
  expect(f.events).toContainEqual({ type: "error", error: { code: "qwen-output-audio-limit" } });
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the old stall deadline on VAD and releases both flow timers on close", async () => {
  const f = fixture();
  f.audio(1_920);
  await vi.advanceTimersByTimeAsync(59_999);
  f.provider.event({ type: "input_audio_buffer.speech_started", item_id: "u", audio_start_ms: 0 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.socket.readyState).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
  f.audio(1_920, "new-audio");
  expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 1, seq: 1, bytes: 960, contextState: "running" })).toBe(true);
  expect(vi.getTimerCount()).toBe(2);
  f.socket.close();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.socket.playbackCredit({ type: "playback.credit", epoch: 1, seq: 2, bytes: 960, contextState: "running" })).toBe(false);
  expect(f.socket.bindMedia(f.media, "credit-v1")).toBe(false);
});
