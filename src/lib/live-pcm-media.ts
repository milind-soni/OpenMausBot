import { t } from "./i18n";
import { qwenAudioOutput } from "./qwen-audio-output";
import { StreamingResampler } from "../../public/qwen-live-worklet.js";
import type { LiveAudioContextState, LiveClientFailure, LiveClientFailureCode, LivePcmTransport, LivePlaybackCredit } from "../../shared/wire";

export const PCM_UPLOAD_LIMIT = 32_000;
export const PCM_PLAYBACK_LIMIT_SECONDS = 3;
export const PCM_SCHEDULE_AHEAD_SECONDS = 0.25;
export const PCM_JITTER_SECONDS = 0.06;
const PLAYBACK_WINDOW_BYTES = 24_000;
const CAPTURE_FRAME_LIMIT = 50;
const CAPTURE_MAX_AGE_MS = 1_000;
const PLAYBACK_NODE_LIMIT = 64;
const PLAYBACK_STALL_MS = 60_000;
const FAILURE_MESSAGES = {
  "upload-backpressure": "call.live.qwen.uploadBackpressure",
  "capture-stale": "call.live.qwen.captureStale",
  "capture-overrun": "call.live.qwen.captureOverrun",
  "playback-buffer": "call.live.qwen.playbackBuffer",
  "playback-stalled": "call.live.qwen.playbackStalled",
  "audio-context": "call.live.qwen.audioUnavailable",
  "media-socket": "call.live.dropped",
  "media-protocol": "call.live.qwen.mediaProtocol",
  "media-processor": "call.live.qwen.audioUnavailable",
} as const satisfies Record<LiveClientFailureCode, string>;

export interface PcmMediaOptions {
  stream: MediaStream;
  callId: string;
  playbackFlow?: LivePcmTransport["playbackFlow"];
  onReady(): void;
  onEvent(raw: string): void;
  onClose(): void;
  onFailure(message: string): void;
}
export interface PcmMediaSession { close(hangup?: boolean): void }

export function createPcmMedia(options: PcmMediaOptions): PcmMediaSession {
  if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") throw new Error(t("call.live.qwen.audioUnavailable"));
  const context = new AudioContext();
  let socket: WebSocket;
  try {
    if (!context.audioWorklet?.addModule) throw new Error();
    // api() uses origin-relative routes in both browser and remote desktop pages. Keep the identical URL resolution.
    socket = new WebSocket("/api/live/media");
  } catch {
    void context.close().catch(() => {});
    throw new Error(t("call.live.qwen.audioUnavailable"));
  }
  socket.binaryType = "arraybuffer";
  const output = qwenAudioOutput.attach(context);
  let resampler = new StreamingResampler(24_000, context.sampleRate);
  const playing = new Set<AudioBufferSourceNode>();
  const playback: { pcm: ArrayBuffer; offset: number }[] = [];
  let queuedBytes = 0;
  let scheduledBytes = 0;
  let playbackTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let creditTimer: ReturnType<typeof setTimeout> | null = null;
  let uploadTimer: ReturnType<typeof setTimeout> | null = null;
  const upload: { pcm: ArrayBuffer; capturedAt: number; receivedAt: number; ageAtReceive: number }[] = [];
  let epoch = 0;
  let seq = 0;
  let flow = false;
  let windowGranted = false;
  let receiveBudget = 0;
  let pendingCredit = 0;
  let pendingPcmBytes = 0;
  let playbackGeneration = 0;
  let nextStart = 0;
  let ready = false;
  let captureReady = false;
  let notifiedReady = false;
  let closed = false;
  let input: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let lastContextState = context.state as string;
  context.addEventListener("statechange", contextChanged);
  socket.onclose = socket.onerror = () => fail("media-socket");
  socket.onopen = () => { try { socket.send(JSON.stringify({ type: "bind", callId: options.callId, ...(options.playbackFlow === "credit-v1" ? { playbackFlow: options.playbackFlow } : {}) })); } catch { fail("media-socket"); } };
  socket.onmessage = (message) => {
    if (closed) return;
    try {
      if (message.data instanceof ArrayBuffer) {
        if (!message.data.byteLength || message.data.byteLength % 2) return fail("media-protocol");
        play(message.data);
        return;
      }
      if (typeof message.data !== "string" || message.data.length > 8_192) return fail("media-protocol");
      const event = JSON.parse(message.data);
      if (!event || typeof event.type !== "string") return fail("media-protocol");
      if (event.type === "media.ready") {
        if (ready) {
          if (event.playbackFlow !== (flow ? "credit-v1" : undefined) || (flow && event.epoch !== epoch)) fail("media-protocol");
          return;
        }
        flow = options.playbackFlow === "credit-v1" && event.playbackFlow === "credit-v1";
        if ((options.playbackFlow === "credit-v1") !== flow || (!flow && event.playbackFlow !== undefined) || (flow && !validEpoch(event.epoch))) return fail("media-protocol");
        epoch = flow ? event.epoch : 0;
        ready = true;
        flushCredit(true);
        announceReady();
      }
      else if (event.type === "audio.clear") {
        if (flow && (!validEpoch(event.epoch) || event.epoch !== epoch + 1)) return fail("media-protocol");
        clearPlayback();
        if (flow) { epoch = event.epoch; seq = 0; windowGranted = false; receiveBudget = 0; flushCredit(true); }
      }
      else if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") options.onEvent(message.data);
    } catch { fail("media-protocol"); }
  };
  void context.audioWorklet.addModule("/qwen-live-worklet.js?v=3").then(() => {
    if (closed) return;
    worklet = new AudioWorkletNode(context, "qwen-live-capture", { channelCount: 1, channelCountMode: "explicit" });
    worklet.onprocessorerror = () => fail("media-processor");
    worklet.port.onmessage = (event) => {
      if (closed || !notifiedReady) return;
      const frame = event.data;
      if (frame?.type === "capture.overrun") return fail("capture-overrun");
      if (frame?.type !== "capture.frame" || !(frame.pcm instanceof ArrayBuffer) || frame.pcm.byteLength !== 640 || !Number.isFinite(frame.capturedAt) || frame.capturedAt < 0 || frame.capturedAt > context.currentTime + 0.05) return fail("media-processor");
      if (upload.length >= CAPTURE_FRAME_LIMIT) return fail("upload-backpressure");
      upload.push({ pcm: frame.pcm, capturedAt: frame.capturedAt, receivedAt: performance.now(), ageAtReceive: Math.max(0, (context.currentTime - frame.capturedAt) * 1_000) });
      drainUpload();
    };
    input = context.createMediaStreamSource(options.stream);
    input.connect(worklet);
    worklet.connect(context.destination);
    captureReady = true;
    announceReady();
    void qwenAudioOutput.resumePlayback();
  }).catch(() => fail("media-processor"));
  function announceReady() {
    if (!closed && ready && captureReady && !notifiedReady) {
      notifiedReady = true;
      worklet!.port.postMessage({ type: "capture.credit", frames: CAPTURE_FRAME_LIMIT });
      options.onReady();
    }
  }
  function frameAge(frame: typeof upload[number]): number { return Math.max(frame.ageAtReceive + performance.now() - frame.receivedAt, (context.currentTime - frame.capturedAt) * 1_000); }
  function drainUpload() {
    if (closed || !upload.length) return;
    if (socket.readyState !== 1) return fail("media-socket");
    while (upload.length) {
      const frame = upload[0];
      if (frameAge(frame) > CAPTURE_MAX_AGE_MS) return fail("capture-stale");
      if (socket.bufferedAmount + frame.pcm.byteLength > PCM_UPLOAD_LIMIT) break;
      try { socket.send(frame.pcm); }
      catch { return fail("media-socket"); }
      upload.shift();
      try { worklet!.port.postMessage({ type: "capture.credit", frames: 1 }); }
      catch { return fail("media-processor"); }
    }
    if (upload.length && !uploadTimer) uploadTimer = setTimeout(() => { uploadTimer = null; drainUpload(); }, 20);
  }
  function validEpoch(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000; }
  function flushCredit(reportState = false) {
    if (closed || !flow || !ready) return;
    const running = context.state === "running";
    const bytes = running ? windowGranted ? pendingCredit : PLAYBACK_WINDOW_BYTES : 0;
    if (!bytes && !reportState) return;
    try {
      socket.send(JSON.stringify({ type: "playback.credit", epoch, seq: ++seq, bytes, contextState: contextState() } satisfies LivePlaybackCredit));
      if (running) { windowGranted = true; pendingCredit = 0; }
      receiveBudget += bytes;
    } catch { fail("media-socket"); }
  }
  function contextChanged() {
    if (closed) return;
    const state = context.state as string;
    if (state === lastContextState) return;
    lastContextState = state;
    if (state === "closed") return fail("audio-context");
    if (creditTimer) clearTimeout(creditTimer);
    creditTimer = null;
    flushCredit(true);
    if (state === "running") drainPlayback();
    else {
      if (playbackTimer) clearTimeout(playbackTimer);
      playbackTimer = null;
      void qwenAudioOutput.resumePlayback();
    }
  }
  function returnCredit(bytes: number) {
    if (!flow) return;
    pendingCredit += bytes;
    if (!creditTimer && context.state === "running") creditTimer = setTimeout(() => { creditTimer = null; flushCredit(); }, 50);
  }
  function play(pcm: ArrayBuffer) {
    if (closed) return;
    if (!ready) return fail("media-protocol");
    if (flow) {
      if (pcm.byteLength > receiveBudget) return fail("media-protocol");
      receiveBudget -= pcm.byteLength;
    }
    if (queuedBytes + pcm.byteLength > PCM_PLAYBACK_LIMIT_SECONDS * 48_000) return fail(flow ? "media-protocol" : "playback-buffer");
    playback.push({ pcm, offset: 0 });
    queuedBytes += pcm.byteLength;
    drainPlayback();
    armPlaybackStall();
  }
  function drainPlayback() {
    if (closed || context.state !== "running") return;
    try {
      while (playback.length && playing.size < PLAYBACK_NODE_LIMIT) {
        const head = playback[0];
        const bytes = Math.min(head.pcm.byteLength - head.offset, 9_120);
        const start = nextStart > context.currentTime ? nextStart : context.currentTime + PCM_JITTER_SECONDS;
        if (start + bytes / 48_000 - context.currentTime > PCM_SCHEDULE_AHEAD_SECONDS) break;
        schedule(head.pcm.slice(head.offset, head.offset + bytes), start);
        head.offset += bytes;
        queuedBytes -= bytes;
        if (head.offset === head.pcm.byteLength) playback.shift();
      }
    } catch { return fail("audio-context"); }
    if (playback.length && !playbackTimer) playbackTimer = setTimeout(() => { playbackTimer = null; drainPlayback(); }, 20);
  }
  function armPlaybackStall(progress = false) {
    if (progress || !(playback.length || playing.size || pendingPcmBytes)) {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (!closed && (playback.length || playing.size || pendingPcmBytes) && !stallTimer) stallTimer = setTimeout(() => { stallTimer = null; fail("playback-stalled"); }, PLAYBACK_STALL_MS);
  }
  function schedule(pcm: ArrayBuffer, start: number) {
    pendingPcmBytes += pcm.byteLength;
    const view = new DataView(pcm);
    const decoded = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
    const samples = resampler.push(decoded);
    if (!samples.length) return;
    const bytes = pendingPcmBytes;
    pendingPcmBytes = 0;
    const generation = playbackGeneration;
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (closed || generation !== playbackGeneration || !playing.delete(source)) return;
      scheduledBytes -= bytes;
      source.disconnect();
      returnCredit(bytes);
      drainPlayback();
      armPlaybackStall(true);
    };
    playing.add(source);
    scheduledBytes += bytes;
    source.start(start);
    nextStart = start + buffer.duration;
  }
  function clearPlayback() {
    playbackGeneration += 1;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    if (creditTimer) clearTimeout(creditTimer);
    creditTimer = null;
    pendingCredit = pendingPcmBytes = 0;
    if (playbackTimer) clearTimeout(playbackTimer);
    playbackTimer = null;
    playback.length = 0;
    queuedBytes = scheduledBytes = 0;
    for (const source of playing) { source.onended = null; try { source.stop(); } catch {} try { source.disconnect(); } catch {} }
    playing.clear();
    nextStart = 0;
    resampler = new StreamingResampler(24_000, context.sampleRate);
  }
  function contextState(): LiveAudioContextState {
    const state = context.state as string;
    return state === "running" || state === "suspended" || state === "interrupted" ? state : "closed";
  }
  function bounded(value: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0; }
  function fail(code: LiveClientFailureCode) {
    if (closed) return;
    if (code === "media-socket" && notifiedReady) {
      close(false);
      options.onClose();
      return;
    }
    if (flow && ready && socket.readyState === 1) {
      const diagnostic: LiveClientFailure = { type: "client.failure", code, contextState: contextState(), bufferedBytes: bounded(socket.bufferedAmount, 10_000_000), queuedMs: bounded((queuedBytes + scheduledBytes + pendingPcmBytes) / 48 + upload.length * 20, 3_600_000), frameAgeMs: bounded(upload.length ? frameAge(upload[0]) : 0, 3_600_000) };
      try { socket.send(JSON.stringify(diagnostic)); } catch {}
    }
    close(false);
    options.onFailure(t(FAILURE_MESSAGES[code]));
  }
  function close(hangup = true) {
    if (closed) return;
    closed = true;
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = null;
    upload.length = 0;
    context.removeEventListener("statechange", contextChanged);
    if (hangup && socket.readyState === 1) { try { socket.send(JSON.stringify({ type: "hangup" })); } catch {} }
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    if (worklet) {
      worklet.onprocessorerror = null;
      worklet.port.onmessage = null;
      try { worklet.port.postMessage("release"); } catch {}
      try { worklet.port.close(); } catch {}
      try { worklet.disconnect(); } catch {}
    }
    try { input?.disconnect(); } catch {}
    clearPlayback();
    output.release();
    try { socket.close(); } catch {}
    void context.close().catch(() => {});
  }
  return { close };
}
