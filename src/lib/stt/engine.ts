// Universal speech engine: the Windows/Linux stand-in for the macOS Swift
// dictation helper. It implements the SAME contract CallView, GroupCallView,
// Composer and push-to-talk already speak (see electron/speech.mjs):
//
//   start({ endpointMs })  call mode: silence ends the turn
//   start()                manual: runs until finish()
//   finish()               finalize: emits the final transcript, then end
//   stop()                 cancel: emits NOTHING (an intentional mute must
//                          not look like the natural end of a turn)
//   onTranscript           { partial, text } lines, text = full running text
//   onEnd                  { code: 0 | 1 | 2, reason }
//
// Capture: getUserMedia with Chromium's WebRTC echo cancellation, noise
// suppression and AGC, into a 16 kHz AudioContext and a tiny AudioWorklet.
// Endpointing happens here; each finished utterance goes to the harness as
// one WAV (POST /api/stt/transcribe), which holds the provider key.
//
// Half-duplex: whenever no session is live the track is disabled and frames
// are dropped, so nothing the bot says is ever captured or transcribed. In
// call mode the device stays open (gated) between turns so re-listening after
// the bot speaks costs ~0 ms instead of a fresh device open; it is released
// on hang-up (release()) or after an idle timeout.
import { Endpointer, type EndpointerOptions } from "./endpointer";
import { CAPTURE_PROCESSOR, captureWorkletUrl } from "./capture-worklet";
import { durationMs, encodeWav, STT_SAMPLE_RATE } from "./wav";

export type TranscriptLine = { partial?: boolean; text?: string; error?: string };
export type SpeechEndInfo = { code: number | null; reason?: string; message?: string };
export type StartOptions = { endpointMs?: number };

export class SttRequestError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** Sends one WAV, returns its text. Injectable for tests. */
export type Transport = (wav: Uint8Array, signal: AbortSignal) => Promise<string>;

export const postUtterance: Transport = async (wav, signal) => {
  const res = await fetch("/api/stt/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
    signal,
  });
  const body = (await res.json().catch(() => null)) as { text?: unknown; error?: unknown; reason?: unknown } | null;
  if (!res.ok) {
    throw new SttRequestError(
      res.status,
      typeof body?.error === "string" ? body.error : `Speech recognition failed (HTTP ${res.status}).`,
      typeof body?.reason === "string" ? body.reason : undefined,
    );
  }
  return typeof body?.text === "string" ? body.text.trim() : "";
};

// Whisper-family models famously "hear" these in near-silence (they are
// artifacts of subtitle training data). Only phrases nobody says to a bot are
// listed, and only for clips short enough to be a noise burst plus the
// trailing endpoint silence, so a real sentence is never dropped.
const HALLUCINATIONS = /^(thanks for watching!?|thank you for watching\.?|please subscribe\.?|subtitles by .*|you|\.+|\[?\(?(music|blank_audio|silence|applause)\)?\]?)$/i;
function clean(text: string, clipMs: number): string {
  const trimmed = text.trim();
  if (clipMs < 2500 && HALLUCINATIONS.test(trimmed)) return "";
  return trimmed;
}

type FrameSink = (pcm: Int16Array, rms: number) => void;

/** The shared, warm microphone. */
export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: FrameSink | null = null;
  private opening: Promise<void> | null = null;
  private generation = 0;

  open(): Promise<void> {
    if (this.stream && this.context?.state !== "closed") {
      if (this.context?.state === "suspended") return this.context.resume();
      return Promise.resolve();
    }
    if (this.opening) return this.opening;
    const opening = this.acquire();
    this.opening = opening;
    void opening.then(
      () => {
        if (this.opening === opening) this.opening = null;
      },
      () => {
        if (this.opening === opening) this.opening = null;
      },
    );
    return opening;
  }

  private async acquire(): Promise<void> {
    const generation = this.generation;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;

    const cleanup = () => {
      node?.port.close();
      node?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => {});
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      // Gated until attach() hands it a live session: a stop() that ran while
      // the device was opening must not leave a hot mic behind for the warm hold.
      for (const track of stream.getAudioTracks()) track.enabled = false;
      if (this.generation !== generation) {
        cleanup();
        return;
      }

      context = new AudioContext({ sampleRate: STT_SAMPLE_RATE, latencyHint: "interactive" });
      await context.audioWorklet.addModule(captureWorkletUrl());
      if (this.generation !== generation) {
        cleanup();
        return;
      }

      const source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (event: MessageEvent<{ pcm: Int16Array; rms: number }>) => {
        this.sink?.(event.data.pcm, event.data.rms);
      };
      source.connect(node);

      if (context.state === "suspended") await context.resume();
      if (this.generation !== generation) {
        cleanup();
        return;
      }

      this.stream = stream;
      this.context = context;
      this.node = node;
      for (const track of stream.getAudioTracks()) track.enabled = this.sink !== null;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /** Route frames to `sink`, or gate the mic entirely when null. */
  attach(sink: FrameSink | null) {
    this.sink = sink;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = sink !== null;
  }

  close() {
    this.generation += 1;
    this.opening = null;
    this.sink = null;
    this.node?.port.close();
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
    this.node = null;
  }
}

function micFailure(error: unknown): SpeechEndInfo {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return { code: 1, reason: "mic-permission", message: "Microphone access is blocked. Allow it for OpenMausBot in your system privacy settings." };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { code: 1, reason: "mic-missing", message: "No microphone was found. Connect one and try again." };
  }
  if (name === "NotReadableError") {
    return { code: 1, reason: "mic-busy", message: "The microphone is in use by another app." };
  }
  return { code: 1, reason: "mic-failed", message: "The microphone couldn't start." };
}

function sttFailure(error: unknown): SpeechEndInfo {
  if (error instanceof SttRequestError && error.status === 409) {
    return { code: 1, reason: "stt-not-configured", message: error.message };
  }
  return {
    code: 1,
    reason: "stt-failed",
    message: error instanceof Error ? error.message : "Speech recognition failed.",
  };
}

const PREROLL_FRAMES = 15; // 300 ms kept from before speech was detected
const INTERIM_EVERY_MS = 1_000;
const MANUAL_SOFT_CHUNK_MS = 20_000;
const MANUAL_HARD_CHUNK_MS = 28_000;

class Session {
  readonly manual: boolean;
  private readonly engine: UniversalSpeechEngine;
  private readonly endpointer: Endpointer;
  private preroll: Int16Array[] = [];
  private frames: Int16Array[] = [];
  private committed = "";
  private chain: Promise<void> = Promise.resolve();
  private interimAt = 0;
  private interimInFlight: AbortController | null = null;
  private readonly aborts = new Set<AbortController>();
  private done = false;

  constructor(engine: UniversalSpeechEngine, endpointMs: number, tuning?: Partial<EndpointerOptions>) {
    this.engine = engine;
    this.manual = endpointMs <= 0;
    this.endpointer = new Endpointer({ ...tuning, endpointMs: this.manual ? 0 : endpointMs });
  }

  readonly frame: FrameSink = (pcm, rms) => {
    if (this.done) return;
    const event = this.endpointer.push(rms);
    if (this.manual) return this.manualFrame(pcm, rms);

    if (!this.endpointer.inSpeech && event === "none" && this.frames.length === 0) {
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      return;
    }
    if (event === "start") {
      this.frames = [...this.preroll, pcm];
      this.preroll = [];
      return;
    }
    this.frames.push(pcm);
    if (event === "discard") {
      this.frames = [];
      return;
    }
    if (event === "end" || event === "limit") {
      void this.complete();
      return;
    }
    this.maybeInterim();
  };

  private manualFrame(pcm: Int16Array, rms: number) {
    this.frames.push(pcm);
    const ms = durationMs(this.frames);
    // Long dictation: commit a chunk at a quiet moment after 20 s, or at
    // 28 s regardless, keeping every request under the server's 30 s cap.
    if ((ms >= MANUAL_SOFT_CHUNK_MS && rms < 0.02) || ms >= MANUAL_HARD_CHUNK_MS) {
      const chunk = this.frames;
      this.frames = [];
      this.commit(chunk);
      return;
    }
    this.maybeInterim();
  }

  private request(frames: Int16Array[]): Promise<string> {
    const abort = new AbortController();
    this.aborts.add(abort);
    return this.engine.transport(encodeWav(frames), abort.signal)
      .then((text) => clean(text, durationMs(frames)))
      .finally(() => this.aborts.delete(abort));
  }

  /** Queue a chunk; commits land in order even if requests finish out of order. */
  private commit(frames: Int16Array[]) {
    if (durationMs(frames) < 150) return;
    const pending = this.request(frames);
    this.chain = this.chain.then(async () => {
      const text = await pending;
      if (!text) return;
      this.committed = this.committed ? `${this.committed} ${text}` : text;
      if (!this.done) this.engine.emitTranscript(this, { partial: true, text: this.committed });
    });
    // complete() awaits the chain and reports a failure; this only keeps a
    // failed chunk from surfacing as an unhandled rejection before then.
    this.chain.catch(() => {});
  }

  private maybeInterim() {
    if (!this.engine.interim() || this.interimInFlight) return;
    const now = performance.now();
    if (now - this.interimAt < INTERIM_EVERY_MS || durationMs(this.frames) < 600) return;
    this.interimAt = now;
    const snapshot = this.frames.slice();
    const abort = new AbortController();
    this.interimInFlight = abort;
    this.engine.transport(encodeWav(snapshot), abort.signal)
      .then((text) => {
        const said = clean(text, durationMs(snapshot));
        if (this.done || !said) return;
        this.engine.emitTranscript(this, { partial: true, text: this.committed ? `${this.committed} ${said}` : said });
      })
      .catch(() => {}) // interim is best-effort; the final request reports errors
      .finally(() => {
        if (this.interimInFlight === abort) this.interimInFlight = null;
      });
  }

  /** End of turn (call mode) or finish() (manual): transcribe what is left,
   * emit the final line, then end. */
  async complete(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.engine.detach(this);
    this.interimInFlight?.abort();
    const rest = this.frames;
    this.frames = [];
    try {
      if (durationMs(rest) >= 150) this.commitFinal(rest);
      await this.chain;
      this.engine.emitTranscript(this, { partial: false, text: this.committed });
      this.engine.emitEnd(this, { code: 0, reason: "completed" });
    } catch (error) {
      this.engine.emitEnd(this, sttFailure(error));
    }
  }

  private commitFinal(frames: Int16Array[]) {
    const pending = this.request(frames);
    this.chain = this.chain.then(async () => {
      const text = await pending;
      if (text) this.committed = this.committed ? `${this.committed} ${text}` : text;
    });
  }

  cancel() {
    this.done = true;
    this.interimInFlight?.abort();
    for (const abort of this.aborts) abort.abort();
    this.aborts.clear();
    this.chain.catch(() => {});
  }
}

export type EngineOptions = {
  transport?: Transport;
  /** Whether partial transcripts are cheap enough to request (local STT). */
  interim?: () => boolean;
  /** How long a call-mode mic stays open (gated) between turns. */
  warmHoldMs?: number;
  endpointer?: Partial<EndpointerOptions>;
  microphone?: () => Pick<Microphone, "open" | "attach" | "close">;
};

export class UniversalSpeechEngine {
  readonly transport: Transport;
  readonly interim: () => boolean;
  private readonly warmHoldMs: number;
  private readonly tuning?: Partial<EndpointerOptions>;
  private readonly makeMic: () => Pick<Microphone, "open" | "attach" | "close">;
  private mic: Pick<Microphone, "open" | "attach" | "close"> | null = null;
  private session: Session | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly transcriptListeners = new Set<(line: TranscriptLine) => void>();
  private readonly endListeners = new Set<(info: SpeechEndInfo) => void>();

  constructor(options: EngineOptions = {}) {
    this.transport = options.transport ?? postUtterance;
    this.interim = options.interim ?? (() => false);
    this.warmHoldMs = options.warmHoldMs ?? 30_000;
    this.tuning = options.endpointer;
    this.makeMic = options.microphone ?? (() => new Microphone());
  }

  onTranscript(cb: (line: TranscriptLine) => void): () => void {
    this.transcriptListeners.add(cb);
    return () => this.transcriptListeners.delete(cb);
  }

  onEnd(cb: (info: SpeechEndInfo) => void): () => void {
    this.endListeners.add(cb);
    return () => this.endListeners.delete(cb);
  }

  async start(options: StartOptions = {}): Promise<void> {
    this.stop();
    const requested = Number(options.endpointMs);
    const endpointMs = Number.isFinite(requested) && requested > 0 ? Math.min(5_000, Math.max(250, Math.round(requested))) : 0;
    const session = new Session(this, endpointMs, this.tuning);
    this.session = session;
    this.clearIdle();
    try {
      this.mic ??= this.makeMic();
      await this.mic.open();
    } catch (error) {
      this.emitEnd(session, micFailure(error));
      return;
    }
    // stop() or a newer start() may have run while the device was opening
    if (this.session !== session) return;
    this.mic.attach(session.frame);
  }

  /** Cancel silently, like stopSpeech(): no transcript, no end event. */
  async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    session?.cancel();
    this.mic?.attach(null);
    this.scheduleIdle(session?.manual ? 0 : this.warmHoldMs);
  }

  /** Finalize, like finishSpeech(): the session stays owned until it emits. */
  async finish(): Promise<void> {
    await this.session?.complete();
  }

  /** Close the device now (hang-up). */
  release(): void {
    void this.stop();
    this.clearIdle();
    this.mic?.close();
    this.mic = null;
  }

  // ── used by Session ──
  detach(session: Session) {
    if (this.session !== session) return;
    this.mic?.attach(null); // gate immediately: half-duplex while we transcribe
  }

  emitTranscript(session: Session, line: TranscriptLine) {
    if (this.session !== session) return;
    for (const cb of this.transcriptListeners) cb(line);
  }

  emitEnd(session: Session, info: SpeechEndInfo) {
    if (this.session !== session) return;
    this.session = null;
    this.scheduleIdle(session.manual ? 0 : this.warmHoldMs);
    for (const cb of this.endListeners) cb(info);
  }

  private scheduleIdle(ms: number) {
    this.clearIdle();
    if (!this.mic) return;
    if (ms <= 0) {
      this.mic.close();
      this.mic = null;
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.session) return;
      this.mic?.close();
      this.mic = null;
    }, ms);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
