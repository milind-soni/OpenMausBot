// Take turns and dictation where the Mac's speech helper does not exist: the page records the mic, trims silence, and
// the harness sends each clip to Fish Audio. It speaks the same five-method contract as window.ogb's speech bridge.
import { api, ApiError } from "@/state/api";
import { t } from "./i18n";
import { createScreenWake } from "./screen-wake";

export type SpeechBridge = Required<
  Pick<NonNullable<Window["ogb"]>, "speechStart" | "speechStop" | "speechFinish" | "onSpeechTranscript" | "onSpeechEnd">
>;
type Line = Parameters<Parameters<SpeechBridge["onSpeechTranscript"]>[0]>[0];
type End = Parameters<Parameters<SpeechBridge["onSpeechEnd"]>[0]>[0];

export const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 1024;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
const SPEECH_RMS = 0.015;
const SPEECH_FRAMES = 3;
const LEAD_MS = 400;
const TAIL_MS = 400;
const CALL_TURN_MAX_MS = 60_000;
const MANUAL_MAX_MS = 5 * 60_000;
const UPLOAD_TIMEOUT_MS = 70_000;

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / (frame.length || 1));
}

export type Heard = "waiting" | "speaking" | "done";

/** `endpointMs` set: quiet that long after speech ends the turn. Unset: only the cap ends it. */
export function createEndpointer(endpointMs: number | undefined, frameMs = FRAME_MS) {
  const cap = endpointMs === undefined ? MANUAL_MAX_MS : CALL_TURN_MAX_MS;
  let loud = 0;
  let quiet = 0;
  let elapsed = 0;
  let spoke = false;
  return (level: number): Heard => {
    elapsed += frameMs;
    if (level > SPEECH_RMS) {
      loud += 1;
      quiet = 0;
      if (loud >= SPEECH_FRAMES) spoke = true;
    } else {
      loud = 0;
      if (spoke) quiet += frameMs;
    }
    if (elapsed >= cap || (endpointMs !== undefined && spoke && quiet >= endpointMs)) return "done";
    return spoke ? "speaking" : "waiting";
  };
}

/** Keeps the last LEAD_MS before speech starts and, once it does, everything up to a short tail after the last loud frame. */
export function createClip(frameMs = FRAME_MS) {
  const lead = Math.ceil(LEAD_MS / frameMs) + SPEECH_FRAMES;
  const tail = Math.ceil(TAIL_MS / frameMs);
  let frames: Float32Array[] = [];
  let spoke = false;
  let lastLoud = -1;
  return {
    push(frame: Float32Array, level: number, heard: Heard) {
      frames.push(frame);
      if (!spoke && heard === "waiting" && frames.length > lead) frames = frames.slice(-lead);
      if (heard !== "waiting") spoke = true;
      if (level > SPEECH_RMS) lastLoud = frames.length - 1;
    },
    get spoke() {
      return spoke;
    },
    frames: () => (spoke ? frames.slice(0, lastLoud + 1 + tail) : []),
  };
}

export function encodeWav(frames: Float32Array[], rate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const samples = frames.reduce((n, frame) => n + frame.length, 0);
  const out = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, value: string) => [...value].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples * 2, true);
  let at = 44;
  for (const frame of frames) {
    for (const sample of frame) {
      const clamped = Math.max(-1, Math.min(1, sample));
      out.setInt16(at, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      at += 2;
    }
  }
  return new Uint8Array(out.buffer);
}

type Mic = { stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode };
type Session =
  | { phase: "idle" }
  | { phase: "opening" }
  | { phase: "listening"; mic: Mic; clip: ReturnType<typeof createClip> }
  | { phase: "transcribing"; abort: AbortController };

const transcriptListeners = new Set<(line: Line) => void>();
const endListeners = new Set<(info: End) => void>();
// Every start, stop and finish bumps this, so a late mic grant or upload can never speak for the next session.
let generation = 0;
let session: Session = { phase: "idle" };
const screenWake = createScreenWake();
let stopWatchingHidden: (() => void) | null = null;

// A lock or app switch hides the page mid-capture: keep what was heard instead of losing the clip.
function watchHidden() {
  stopWatchingHidden?.();
  if (typeof document === "undefined") return;
  const onHidden = () => {
    if (document.visibilityState === "hidden") finishCapture(generation, true);
  };
  document.addEventListener("visibilitychange", onHidden);
  stopWatchingHidden = () => document.removeEventListener("visibilitychange", onHidden);
}

const emitTranscript = (line: Line) => Array.from(transcriptListeners).forEach((fn) => fn(line));
const emitEnd = (info: End) => Array.from(endListeners).forEach((fn) => fn(info));
const completed = (): End => ({ code: 0, reason: "completed" });

function release(mic: Mic) {
  mic.processor.onaudioprocess = null;
  mic.source.disconnect();
  mic.processor.disconnect();
  for (const track of mic.stream.getTracks()) track.stop();
  void mic.context.close().catch(() => {});
}

function teardown() {
  generation += 1;
  if (session.phase === "listening") release(session.mic);
  if (session.phase === "transcribing") session.abort.abort();
  session = { phase: "idle" };
  stopWatchingHidden?.();
  stopWatchingHidden = null;
  screenWake.release();
}

function micFailure(error: unknown): End {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError") return { code: 1, reason: "microphone-blocked", message: t("call.live.micBlocked") };
  if (name === "NotFoundError") return { code: 1, reason: "microphone-missing", message: t("call.live.micMissing") };
  return { code: 1, reason: "microphone-failed" };
}

async function upload(gen: number, frames: Float32Array[], abort: AbortController, end: End) {
  try {
    const { text } = await api<{ text?: string }>("/api/tts/transcribe", {
      method: "POST",
      body: encodeWav(frames),
      headers: { "content-type": "audio/wav" },
      signal: abort.signal,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (gen !== generation) return;
    session = { phase: "idle" };
    screenWake.release();
    // An empty final would make a call listen twice: once for it, once for the end.
    if (text?.trim()) emitTranscript({ partial: false, text });
    emitEnd(end);
  } catch (error) {
    if (gen !== generation) return;
    session = { phase: "idle" };
    screenWake.release();
    emitEnd({ code: 1, reason: "transcribe-failed", ...(error instanceof ApiError ? { message: error.message } : {}) });
  }
}

function finishCapture(gen: number, interrupted = false) {
  if (gen !== generation || session.phase !== "listening") return;
  const { mic, clip } = session;
  stopWatchingHidden?.();
  stopWatchingHidden = null;
  release(mic);
  if (!clip.spoke) {
    session = { phase: "idle" };
    screenWake.release();
    return emitEnd(completed());
  }
  const abort = new AbortController();
  session = { phase: "transcribing", abort };
  void upload(gen, clip.frames(), abort, interrupted ? { code: 0, reason: "interrupted" } : completed());
}

export const fishSpeech: SpeechBridge = {
  async speechStart(options) {
    teardown();
    const gen = generation;
    session = { phase: "opening" };
    let stream: MediaStream | undefined;
    let mic: Mic;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      mic = { stream, context, source: context.createMediaStreamSource(stream), processor: context.createScriptProcessor(FRAME_SAMPLES, 1, 1) };
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (gen !== generation) return;
      session = { phase: "idle" };
      return emitEnd(micFailure(error));
    }
    if (gen !== generation) return release(mic);
    const endpointed = options?.endpointMs !== undefined;
    const hear = createEndpointer(options?.endpointMs);
    const clip = createClip();
    let announced = false;
    mic.processor.onaudioprocess = (event) => {
      if (gen !== generation) return;
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      const level = rms(frame);
      const heard = hear(level);
      clip.push(frame, level, heard);
      if (endpointed && !announced && heard !== "waiting") {
        announced = true;
        emitTranscript({ partial: true, text: "…" });
      }
      if (heard === "done") finishCapture(gen);
    };
    mic.source.connect(mic.processor);
    mic.processor.connect(mic.context.destination);
    void mic.context.resume().catch(() => {});
    session = { phase: "listening", mic, clip };
    screenWake.acquire();
    watchHidden();
  },
  async speechStop() {
    teardown();
  },
  async speechFinish() {
    if (session.phase === "listening") return finishCapture(generation);
    if (session.phase === "opening") {
      teardown();
      emitEnd(completed());
    }
  },
  onSpeechTranscript(cb) {
    transcriptListeners.add(cb);
    return () => transcriptListeners.delete(cb);
  },
  onSpeechEnd(cb) {
    endListeners.add(cb);
    return () => endListeners.delete(cb);
  },
};
