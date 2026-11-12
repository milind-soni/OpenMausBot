import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const path = "./live-pcm-media";
const media = await import(/* @vite-ignore */ path).catch(() => ({}));
const { qwenAudioOutput } = await import("./qwen-audio-output");
class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "";
  onopen: any = null;
  onmessage: any = null;
  onerror: any = null;
  onclose: any = null;
  sent: unknown[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  constructor(readonly url: string) { Socket.instances.push(this); }
  send(data: unknown) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data }); }
}
class Worklet {
  static instances: Worklet[] = [];
  port = { onmessage: null as any, postMessage: vi.fn(), close: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(..._args: unknown[]) { Worklet.instances.push(this); }
  frame(pcm = new ArrayBuffer(640), capturedAt = Context.instances.at(-1)!.currentTime) { this.port.onmessage?.({ data: { type: "capture.frame", pcm, capturedAt } }); }
}
class Context extends EventTarget {
  static instances: Context[] = [];
  sinkId = "";
  setSinkId = vi.fn(async (id: string) => { this.sinkId = id; });
  sampleRate = 48_000;
  currentTime = 10;
  state = "running";
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  input = { connect: vi.fn(), disconnect: vi.fn() };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = "closed"; });
  sources: any[] = [];
  constructor() { super(); Context.instances.push(this); }
  createMediaStreamSource() { return this.input; }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const samples = new Float32Array(length);
    return { duration: length / sampleRate, sampleRate, length, copyToChannel: (input: Float32Array) => samples.set(input), getChannelData: () => samples };
  }
  createBufferSource() {
    const source = { buffer: null as any, onended: null as any, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    this.sources.push(source);
    return source;
  }
}
let failure: ReturnType<typeof vi.fn<(message: string) => void>>;
let ready: ReturnType<typeof vi.fn>;
let event: ReturnType<typeof vi.fn>;
let closed: ReturnType<typeof vi.fn>;
let session: any;
const stream = { getTracks: () => [] } as unknown as MediaStream;
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const controls = (socket: Socket) => socket.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value));
const start = async (playbackFlow?: "credit-v1") => {
  expect(media.createPcmMedia).toBeTypeOf("function");
  session = media.createPcmMedia({ stream, callId: "call-fixture", playbackFlow, onReady: ready, onEvent: event, onClose: closed, onFailure: failure });
  await settle();
  return { socket: Socket.instances[0], context: Context.instances[0], worklet: Worklet.instances[0] };
};
beforeEach(() => {
  failure = vi.fn(); ready = vi.fn(); event = vi.fn(); closed = vi.fn();
  Socket.instances = []; Context.instances = []; Worklet.instances = [];
  vi.stubGlobal("location", { href: "https://app.example.test/chat?from=fixture#live" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
});
afterEach(() => { session?.close(); session = null; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Qwen browser PCM relay", () => {
  it.each([
    ["https://app.example.test:8443/chat?secret=fixture#live", "wss://app.example.test:8443/api/live/media"],
    ["http://127.0.0.1:8799/chat", "ws://127.0.0.1:8799/api/live/media"],
    ["http://[::1]:8799/", "ws://[::1]:8799/api/live/media"],
  ])("uses an absolute same-origin WebSocket URL from %s", async (href, expected) => {
    vi.stubGlobal("location", { href });
    class AbsoluteSocket extends Socket {
      constructor(url: string) { new URL(url); super(url); }
    }
    vi.stubGlobal("WebSocket", AbsoluteSocket);
    const { socket } = await start("credit-v1");
    expect(String(socket.url)).toBe(expected);
    expect(failure).not.toHaveBeenCalled();
  });

  it("classifies a failed frame-credit port as processor failure after the PCM entered WS", async () => {
    const { socket, worklet } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    worklet.port.postMessage.mockImplementation(() => { throw new Error("detached fixture"); });
    const pcm = new ArrayBuffer(640);
    worklet.frame(pcm);
    expect(socket.sent.filter((value) => value instanceof ArrayBuffer)).toEqual([pcm]);
    expect(controls(socket).at(-1)).toMatchObject({ type: "client.failure", code: "media-processor" });
    expect(failure).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it("bounds scheduled node count as well as PCM time for fragmented legacy packets", async () => {
    const { socket, context } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    for (let i = 0; i < 300; i++) socket.message(new ArrayBuffer(2));
    expect(context.sources.length).toBeLessThanOrEqual(64);
    expect(failure).not.toHaveBeenCalled();
  });
  it("reports stalled playback only with pending audio, not an idle connected call", async () => {
    vi.useFakeTimers();
    const { socket } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failure).not.toHaveBeenCalled();
    socket.message(new ArrayBuffer(960));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(failure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(controls(socket).at(-1)).toMatchObject({ type: "client.failure", code: "playback-stalled", queuedMs: 20 });
    expect(String(failure.mock.calls[0][0])).not.toMatch(/network|slow/i);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("still releases all resources if the capture port is already detached", async () => {
    vi.useFakeTimers();
    const { socket, context, worklet } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    socket.message(new ArrayBuffer(960));
    worklet.port.postMessage.mockImplementation(() => { throw new Error("detached fixture"); });
    expect(() => session.close()).not.toThrow();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.input.disconnect).toHaveBeenCalledOnce();
    expect(qwenAudioOutput.getSnapshot().active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["legacy-with-cap", "cap-without-ready-cap", "bad-ready-epoch", "changed-ready", "early-pcm"])("rejects inconsistent media negotiation (%s) without inventing legacy controls", async (fault) => {
    const { socket } = await start(fault === "legacy-with-cap" ? undefined : "credit-v1");
    socket.open();
    if (fault === "early-pcm") socket.message(new ArrayBuffer(960));
    else if (fault === "cap-without-ready-cap") socket.message(JSON.stringify({ type: "media.ready" }));
    else socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: fault === "bad-ready-epoch" ? -1 : 0 }));
    if (fault === "changed-ready") socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 1 }));
    expect(failure).toHaveBeenCalledOnce();
    if (fault !== "changed-ready") expect(controls(socket)).toHaveLength(1);
    expect(controls(socket).some(({ type }) => type === "hangup")).toBe(false);
  });
  it.each(["blocked", "pending"])("starts a suspended capture graph without hanging up on a %s initial resume", async (mode) => {
    class PausedContext extends Context {
      constructor() {
        super();
        this.state = "suspended";
        this.resume = mode === "blocked" ? vi.fn(async () => { throw new DOMException("fixture", "NotAllowedError"); }) : vi.fn(() => new Promise<void>(() => {}));
      }
    }
    vi.stubGlobal("AudioContext", PausedContext);
    const { socket, context } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    expect(ready).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(controls(socket).at(-1)).toMatchObject({ bytes: 0, contextState: "suspended" });
    expect(qwenAudioOutput.getSnapshot()).toMatchObject({ active: true, playbackPaused: true });
    context.resume.mockImplementationOnce(async () => { context.state = "running"; context.dispatchEvent(new Event("statechange")); });
    await qwenAudioOutput.resumePlayback();
    expect(controls(socket).at(-1)).toMatchObject({ bytes: 24_000, contextState: "running" });
    expect(ready).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
  });
  it.each(["capture-stale", "capture-overrun", "upload-backpressure", "media-protocol", "media-processor", "audio-context"])("reports one bounded %s failure without a hangup or private payload", async (code) => {
    vi.useFakeTimers();
    const { socket, context, worklet } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    const processorError = (worklet as any).onprocessorerror;
    const socketError = socket.onerror;
    if (code === "capture-stale") worklet.frame(new ArrayBuffer(640), context.currentTime - 1.2);
    if (code === "capture-overrun") worklet.port.onmessage({ data: { type: "capture.overrun", secret: "private fixture" } });
    if (code === "upload-backpressure") { socket.bufferedAmount = 32_000; for (let i = 0; i < 51; i++) worklet.frame(); }
    if (code === "media-protocol") socket.message(new ArrayBuffer(24_002));
    if (code === "media-processor") processorError({ message: "private fixture" });
    if (code === "audio-context") { context.state = "closed"; context.dispatchEvent(new Event("statechange")); }
    processorError(); socketError(); session.close();
    const failures = controls(socket).filter(({ type }) => type === "client.failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({ type: "client.failure", code, contextState: code === "audio-context" ? "closed" : "running", bufferedBytes: expect.any(Number), queuedMs: expect.any(Number), frameAgeMs: expect.any(Number) });
    for (const key of ["bufferedBytes", "queuedMs", "frameAgeMs"]) expect(Number.isInteger(failures[0][key]) && failures[0][key] >= 0).toBe(true);
    if (code === "capture-stale") expect(failures[0].frameAgeMs).toBeGreaterThanOrEqual(1_199);
    expect(controls(socket).some(({ type }) => type === "hangup")).toBe(false);
    expect(JSON.stringify(failures)).not.toMatch(/private|deviceId|pcm|secret/);
    expect(failure).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(String(failure.mock.calls[0][0])).not.toMatch(/private fixture/);
    if (code.startsWith("capture") || code === "upload-backpressure") expect(String(failure.mock.calls[0][0])).toMatch(/repeat/i);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects untimestamped legacy worklet messages rather than forwarding unbounded old capture", async () => {
    const { socket, worklet } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    worklet.port.onmessage({ data: new ArrayBuffer(640) });
    expect(failure).toHaveBeenCalledOnce();
    expect(socket.sent.filter((value) => value instanceof ArrayBuffer)).toHaveLength(0);
    expect(controls(socket)).toEqual([{ type: "bind", callId: "call-fixture" }]);
  });
  it("preserves short upload backpressure in FIFO and returns frame credit only after WS send", async () => {
    vi.useFakeTimers();
    const { socket, context, worklet } = await start();
    expect(worklet.port.postMessage).not.toHaveBeenCalled();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    expect(worklet.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "capture.credit", frames: 50 });
    socket.bufferedAmount = 32_000;
    const frames = Array.from({ length: 4 }, () => new ArrayBuffer(640));
    for (const frame of frames) worklet.frame(frame);
    expect(failure).not.toHaveBeenCalled();
    expect(socket.sent.filter((data) => data instanceof ArrayBuffer)).toHaveLength(0);
    expect(worklet.port.postMessage).toHaveBeenCalledTimes(1);
    context.currentTime += 0.2;
    await vi.advanceTimersByTimeAsync(200);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.sent.filter((data) => data instanceof ArrayBuffer)).toEqual(frames);
    expect(worklet.port.postMessage.mock.calls.slice(1)).toEqual(frames.map(() => [{ type: "capture.credit", frames: 1 }]));
    expect(failure).not.toHaveBeenCalled();
    session.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["received stale", "queued stale", "wall clock stale", "queue full"])("fails closed instead of losing a middle capture frame (%s)", async (fault) => {
    vi.useFakeTimers();
    const { socket, context, worklet } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    socket.bufferedAmount = fault === "received stale" ? 0 : 32_000;
    worklet.frame(new ArrayBuffer(640), fault === "received stale" ? context.currentTime - 1.001 : context.currentTime);
    if (fault === "queued stale") { context.currentTime += 1.001; await vi.advanceTimersByTimeAsync(20); }
    if (fault === "wall clock stale") await vi.advanceTimersByTimeAsync(1_020);
    if (fault === "queue full") for (let i = 0; i < 50; i++) worklet.frame();
    expect(failure).toHaveBeenCalledOnce();
    expect(socket.sent.filter((data) => data instanceof ArrayBuffer)).toHaveLength(0);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["suspended", "interrupted"])("keeps a %s call and its FIFO, with zero new credit until explicit resume", async (state) => {
    vi.useFakeTimers();
    const { socket, context } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    context.resume.mockRejectedValue(new DOMException("fixture autoplay", "NotAllowedError"));
    context.state = state;
    context.dispatchEvent(new Event("statechange"));
    await settle();
    expect(controls(socket).at(-1)).toMatchObject({ type: "playback.credit", bytes: 0, contextState: state });
    for (let i = 0; i < 25; i++) socket.message(new ArrayBuffer(960));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(context.sources).toHaveLength(0);
    expect(qwenAudioOutput.getSnapshot()).toMatchObject({ active: true, playbackPaused: true });
    expect(failure).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    context.resume.mockImplementationOnce(async () => { context.state = "running"; context.dispatchEvent(new Event("statechange")); });
    await qwenAudioOutput.resumePlayback();
    expect(qwenAudioOutput.getSnapshot()).toMatchObject({ active: true, playbackPaused: false });
    expect(context.sources.length).toBeGreaterThan(0);
    expect(controls(socket).at(-1)).toMatchObject({ bytes: 0, contextState: "running" });
    expect(controls(socket).filter(({ bytes }) => bytes > 0)).toHaveLength(1);
    context.currentTime += 0.4;
    context.sources[0].onended();
    await vi.advanceTimersByTimeAsync(50);
    expect(controls(socket).at(-1)).toMatchObject({ bytes: 960, contextState: "running" });
    const remove = vi.spyOn(context, "removeEventListener");
    session.close();
    expect(remove.mock.calls.filter(([type]) => type === "statechange")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    context.dispatchEvent(new Event("statechange"));
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it("negotiates the declared credit window and returns only ended PCM bytes in 50 ms batches", async () => {
    vi.useFakeTimers();
    const { socket, context } = await start("credit-v1");
    socket.open();
    expect(controls(socket)).toEqual([{ type: "bind", callId: "call-fixture", playbackFlow: "credit-v1" }]);
    socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    expect(controls(socket).slice(1)).toEqual([{ type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" }]);
    socket.message(new ArrayBuffer(960)); socket.message(new ArrayBuffer(960));
    await vi.advanceTimersByTimeAsync(100);
    expect(controls(socket)).toHaveLength(2);
    context.currentTime = 10.2;
    context.sources[0].onended(); context.sources[1].onended();
    await vi.advanceTimersByTimeAsync(49);
    expect(controls(socket)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(controls(socket).at(-1)).toEqual({ type: "playback.credit", epoch: 0, seq: 2, bytes: 1_920, contextState: "running" });
    session.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("isolates cleared epochs from late source endings and cancels old credit batches", async () => {
    vi.useFakeTimers();
    const { socket, context } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    socket.message(new ArrayBuffer(960)); socket.message(new ArrayBuffer(960));
    const late = context.sources[1].onended;
    context.sources[0].onended();
    socket.message(JSON.stringify({ type: "audio.clear", epoch: 1 }));
    const credits = controls(socket).filter(({ type }) => type === "playback.credit");
    expect(credits.at(-1)).toMatchObject({ epoch: 1, seq: 1, bytes: 24_000 });
    late();
    await vi.advanceTimersByTimeAsync(100);
    expect(controls(socket).filter(({ type }) => type === "playback.credit")).toEqual(credits);
    socket.message(new ArrayBuffer(960));
    context.sources[2].onended();
    await vi.advanceTimersByTimeAsync(50);
    expect(controls(socket).at(-1)).toMatchObject({ epoch: 1, seq: 2, bytes: 960 });
  });
  it("does not block capture when optional output device enumeration stalls", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: () => new Promise(() => {}), addEventListener() {}, removeEventListener() {} } });
    const { socket } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    expect(Worklet.instances).toHaveLength(1);
    expect(ready).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });
  it("routes its real playback context, survives a refused switch, and detaches before the next call", async () => {
    const { context, socket } = await start();
    expect(qwenAudioOutput.getSnapshot().active).toBe(true);
    await qwenAudioOutput.select("headset-fixture");
    expect(context.setSinkId).toHaveBeenCalledExactlyOnceWith("headset-fixture");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    socket.message(new ArrayBuffer(4_800));
    expect(context.sources[0].connect).toHaveBeenCalledWith(context.destination);
    context.setSinkId.mockRejectedValueOnce(new DOMException("fixture", "NotAllowedError"));
    await qwenAudioOutput.select("speaker-fixture");
    expect(qwenAudioOutput.getSnapshot()).toMatchObject({ active: true, selectedId: "headset-fixture", error: "permission" });
    expect(failure).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    session.close();
    expect(qwenAudioOutput.getSnapshot().active).toBe(false);
    const remove = vi.spyOn(context, "removeEventListener");
    session = media.createPcmMedia({ stream, callId: "next-call", onReady: ready, onEvent: event, onClose: closed, onFailure: failure });
    await settle();
    const next = Context.instances[1];
    expect(next.setSinkId).toHaveBeenCalledWith("headset-fixture");
    const previousCalls = context.setSinkId.mock.calls.length;
    await qwenAudioOutput.select("");
    expect(next.setSinkId).toHaveBeenLastCalledWith("");
    expect(context.setSinkId).toHaveBeenCalledTimes(previousCalls);
    expect(remove).not.toHaveBeenCalled();
  });
  it("closes the relay when the capture processor fails", async () => {
    const { worklet, context, socket } = await start();
    const processorError = (worklet as any).onprocessorerror;
    expect(processorError).toBeTypeOf("function");
    processorError();
    expect(failure).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect((worklet as any).onprocessorerror).toBeNull();
  });
  it.each(["missing audioWorklet", "socket construction"])("releases the context when synchronous setup fails (%s)", async (fault) => {
    if (fault === "missing audioWorklet") {
      class MissingModule extends Context { constructor() { super(); this.audioWorklet = undefined as never; } }
      vi.stubGlobal("AudioContext", MissingModule);
    } else vi.stubGlobal("WebSocket", class { constructor() { throw new Error("socket cannot open"); } });
    expect(() => media.createPcmMedia({ stream, callId: "partial", onReady: ready, onEvent: event, onClose: closed, onFailure: failure })).toThrow();
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
  });

  it("releases media and reports transport closure when a ready capture frame cannot be sent", async () => {
    const { socket, worklet } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    socket.send = () => { throw new Error("closing"); };
    expect(() => worklet.frame()).not.toThrow();
    expect(closed).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it.each([2, 3])("reports transport closure when the upload timer finds socket state %s before onclose", async (socketState) => {
    vi.useFakeTimers();
    const { socket, worklet } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    socket.bufferedAmount = 32_000;
    worklet.frame();
    const onclose = socket.onclose;
    socket.readyState = socketState;
    await vi.advanceTimersByTimeAsync(20);
    onclose();
    expect(closed).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(socket.sent.filter((value) => value instanceof ArrayBuffer)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports transport closure when a ready playback credit cannot be sent", async () => {
    vi.useFakeTimers();
    const { socket, context } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    socket.message(new ArrayBuffer(960));
    context.sources[0].onended();
    socket.send = () => { throw new Error("closing"); };
    await vi.advanceTimersByTimeAsync(50);
    expect(closed).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("announces media ready only once, after the capture worklet is running", async () => {
    let loaded!: () => void;
    class LoadingContext extends Context {
      constructor() { super(); this.audioWorklet.addModule = vi.fn(() => new Promise<void>((resolve) => { loaded = resolve; })); }
    }
    vi.stubGlobal("AudioContext", LoadingContext);
    session = media.createPcmMedia({ stream, callId: "loading", onReady: ready, onEvent: event, onClose: closed, onFailure: failure });
    const socket = Socket.instances[0];
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    expect(ready).not.toHaveBeenCalled();
    loaded(); await settle();
    expect(ready).toHaveBeenCalledOnce();
    socket.message(JSON.stringify({ type: "media.ready" }));
    expect(ready).toHaveBeenCalledOnce();
  });
  it.each(["context", "worklet", "module"])("explains unavailable WebAudio (%s) and releases partial setup", async (missing) => {
    if (missing === "context") vi.stubGlobal("AudioContext", undefined);
    if (missing === "worklet") vi.stubGlobal("AudioWorkletNode", undefined);
    if (missing === "module") {
      class RefusingContext extends Context {
        constructor() {
          super();
          this.audioWorklet.addModule = vi.fn(async () => { throw new Error("blocked by CSP"); });
        }
      }
      vi.stubGlobal("AudioContext", RefusingContext);
    }
    try { session = media.createPcmMedia({ stream, callId: "unavailable", onReady: ready, onEvent: event, onClose: closed, onFailure: failure }); }
    catch (error) { failure((error as Error).message); }
    await settle();
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0][0]).toMatch(/audio|AudioWorklet/);
    for (const context of Context.instances) expect(context.close).toHaveBeenCalledOnce();
  });
  it.each(["not json", "null", "x".repeat(8_193), new ArrayBuffer(3)])("closes malformed or oversized media without uncaught errors (%#)", async (data) => {
    const { socket } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    expect(() => socket.message(data)).not.toThrow();
    expect(failure).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it.each(["onclose", "onerror"])("fails once on pre-ready socket %s without reconnecting", async (handler) => {
    const { socket, context } = await start();
    socket.open();
    const callback = socket[handler as "onclose"];
    expect(callback).toBeTypeOf("function");
    callback(); callback();
    expect(failure).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(1);
  });
  it.each(["error", 1000, 1006])("releases ready media once before reporting socket closure (%s)", async (first) => {
    vi.useFakeTimers();
    const { socket, context, worklet } = await start("credit-v1");
    socket.open(); socket.message(JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 }));
    socket.message(new ArrayBuffer(960));
    const onerror = socket.onerror;
    const onclose = socket.onclose;
    closed.mockImplementation(() => {
      expect(context.close).toHaveBeenCalledOnce();
      expect(worklet.disconnect).toHaveBeenCalledOnce();
      expect(context.input.disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
    if (first === "error") onerror();
    else onclose({ code: first });
    onclose({ code: 1000 }); onerror();
    expect(closed).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(controls(socket).some(({ type }) => type === "hangup" || type === "client.failure")).toBe(false);
    expect(Socket.instances).toHaveLength(1);
  });
  it("fails immediately if the socket closes after negotiation while the worklet is still loading", async () => {
    let loaded!: () => void;
    class LoadingContext extends Context {
      constructor() { super(); this.audioWorklet.addModule = vi.fn(() => new Promise<void>((resolve) => { loaded = resolve; })); }
    }
    vi.stubGlobal("AudioContext", LoadingContext);
    session = media.createPcmMedia({ stream, callId: "loading", onReady: ready, onEvent: event, onClose: closed, onFailure: failure });
    const socket = Socket.instances[0];
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    socket.onclose();
    loaded(); await settle();
    expect(failure).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(Worklet.instances).toHaveLength(0);
  });
  it("buffers a bounded legacy burst in FIFO order while scheduling at most 250 ms ahead", async () => {
    vi.useFakeTimers();
    const { socket, context } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    for (let i = 0; i < 10; i++) {
      const pcm = new ArrayBuffer(4_800);
      new Int16Array(pcm).fill((i + 1) * 1_000);
      socket.message(pcm);
    }
    expect(failure).not.toHaveBeenCalled();
    expect(context.sources.length).toBeGreaterThan(0);
    expect(context.sources.length).toBeLessThanOrEqual(3);
    const levels: number[] = [];
    let consumed = 0;
    for (let step = 0; step < 70; step++) {
      context.currentTime += 0.02;
      for (const source of context.sources.slice(consumed)) {
        const end = source.start.mock.calls[0][0] + source.buffer.duration;
        if (end > context.currentTime) break;
        levels.push(source.buffer.getChannelData(0)[500]);
        consumed += 1;
        source.onended?.();
      }
      await vi.advanceTimersByTimeAsync(20);
      const latest = context.sources.at(-1);
      expect(latest.start.mock.calls[0][0] + latest.buffer.duration - context.currentTime).toBeLessThanOrEqual(0.251);
    }
    expect(levels).toHaveLength(10);
    levels.forEach((level, i) => expect(level).toBeCloseTo((i + 1) * 1_000 / 32768, 4));
    expect(failure).not.toHaveBeenCalled();
  });
  it("ends on a legacy FIFO exceeding its extra 3 second budget and stops every scheduled source", async () => {
    const { socket, context } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    for (let i = 0; i < 32; i++) socket.message(new ArrayBuffer(4_800));
    expect(failure).toHaveBeenCalledOnce();
    expect(context.sources.length).toBeLessThanOrEqual(3);
    for (const source of context.sources) expect(source.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
  it("clears scheduled playback immediately on audio.clear and passes only captions to the call", async () => {
    const { socket, context } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    socket.message(new ArrayBuffer(4_800));
    const first = context.sources[0];
    socket.message(JSON.stringify({ type: "audio.clear" }));
    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.disconnect).toHaveBeenCalledOnce();
    socket.message(new ArrayBuffer(4_800));
    expect(context.sources[1].start).toHaveBeenCalledWith(10.06);
    const caption = JSON.stringify({ type: "session.output_transcript.delta", delta: "hello" });
    socket.message(caption);
    socket.message(JSON.stringify({ type: "response.create", text: "not a caption" }));
    expect(event).toHaveBeenCalledExactlyOnceWith(caption);
    expect(socket.sent).toEqual([JSON.stringify({ type: "bind", callId: "call-fixture" })]);
  });
  it("plays 24 kHz PCM as continuous 48 kHz buffers behind a jitter floor", async () => {
    vi.useFakeTimers();
    const { socket, context } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    const pcm = new ArrayBuffer(4_800);
    const view = new DataView(pcm);
    for (let i = 0; i < 2_400; i++) view.setInt16(i * 2, Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 1000 * i / 24_000)), true);
    socket.message(pcm); socket.message(pcm);
    context.currentTime += 0.02;
    await vi.advanceTimersByTimeAsync(20);
    expect(context.sources).toHaveLength(2);
    const [first, second] = context.sources;
    expect(first.buffer.sampleRate).toBe(48_000);
    expect(first.start).toHaveBeenCalledWith(10.06);
    expect(second.start.mock.calls[0][0]).toBeCloseTo(10.06 + first.buffer.duration, 8);
    const samples = first.buffer.getChannelData(0).slice(200);
    const amplitude = Math.sqrt(samples.reduce((sum: number, x: number) => sum + x * x, 0) / samples.length);
    expect(amplitude).toBeCloseTo(0.5 / Math.sqrt(2), 2);
    expect(failure).not.toHaveBeenCalled();
  });
  it("fails closed on sustained legacy upload backpressure instead of dropping a middle frame", async () => {
    vi.useFakeTimers();
    const { socket, worklet, context } = await start();
    socket.open(); socket.message(JSON.stringify({ type: "media.ready" }));
    socket.bufferedAmount = 32_000;
    worklet.frame();
    await vi.advanceTimersByTimeAsync(1_020);
    expect(failure).toHaveBeenCalledOnce();
    expect(String(failure.mock.calls[0][0])).toMatch(/repeat/i);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(socket.sent.filter((value) => value instanceof ArrayBuffer)).toHaveLength(0);
    expect(Socket.instances).toHaveLength(1);
  });
  it("releases capture, context, listeners and socket exactly once, including hangup", async () => {
    const { socket, worklet, context } = await start();
    socket.open();
    socket.message(JSON.stringify({ type: "media.ready" }));
    session.close(); session.close();
    expect(socket.sent.slice(1)).toEqual([JSON.stringify({ type: "hangup" })]);
    expect(worklet.port.postMessage.mock.calls).toEqual([[{ type: "capture.credit", frames: 50 }], ["release"]]);
    expect(worklet.port.close).toHaveBeenCalledOnce();
    expect(worklet.disconnect).toHaveBeenCalledOnce();
    expect(context.input.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect([socket.onmessage, socket.onopen, socket.onclose, socket.onerror, worklet.port.onmessage]).toEqual([null, null, null, null, null]);
  });

  it("does not revive a capture node after release while its module was loading", async () => {
    let loaded!: () => void;
    const addModule = vi.spyOn(Context.prototype, "createMediaStreamSource");
    const original = Context.prototype.constructor;
    class LoadingContext extends Context {
      constructor() { super(); this.audioWorklet.addModule = vi.fn(() => new Promise<void>((resolve) => { loaded = resolve; })); }
    }
    expect(original).toBeTruthy();
    vi.stubGlobal("AudioContext", LoadingContext);
    session = media.createPcmMedia({ stream, callId: "cancelled", onReady: ready, onEvent: event, onClose: closed, onFailure: failure });
    session.close();
    loaded(); await settle();
    expect(Worklet.instances).toHaveLength(0);
    expect(addModule).not.toHaveBeenCalled();
    addModule.mockRestore();
  });
  it("binds on the fixed same-origin route before sending binary capture after media.ready", async () => {
    const { socket, worklet, context } = await start();
    expect(socket.url).toBe("wss://app.example.test/api/live/media");
    expect(context.audioWorklet.addModule).toHaveBeenCalledExactlyOnceWith("/qwen-live-worklet.js?v=3");
    expect(socket.binaryType).toBe("arraybuffer");
    worklet.frame();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([JSON.stringify({ type: "bind", callId: "call-fixture" })]);
    worklet.frame();
    expect(socket.sent).toHaveLength(1);
    socket.message(JSON.stringify({ type: "media.ready" }));
    const frame = new ArrayBuffer(640);
    worklet.frame(frame);
    expect(socket.sent).toEqual([JSON.stringify({ type: "bind", callId: "call-fixture" }), frame]);
    expect(ready).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });
});
