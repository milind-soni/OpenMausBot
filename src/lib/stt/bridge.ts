// One speech bridge for every caller (CallView, GroupCallView, Composer,
// push-to-talk, call.ts). On macOS it is a thin pass-through to the native
// Swift helper exposed by preload, so Mac behavior is byte-for-byte what it
// was. On Windows and Linux it is the UniversalSpeechEngine, which speaks the
// identical contract.
import type { ConfigStatus } from "@/state/store";
import { UniversalSpeechEngine, type SpeechEndInfo, type StartOptions, type TranscriptLine } from "./engine";

export type { SpeechEndInfo, TranscriptLine } from "./engine";

export interface SpeechBridge {
  readonly kind: "native" | "universal";
  start(options?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  finish(): Promise<void>;
  /** Stop and close the microphone now (hang-up). For the native helper
   * this is exactly speechStop(); it already exits after every session. */
  release(): void;
  onTranscript(cb: (line: TranscriptLine) => void): () => void;
  onEnd(cb: (info: SpeechEndInfo) => void): () => void;
}

type SttStatus = ConfigStatus["stt"];

let sttStatus: SttStatus;
/** Keeps the engine's interim policy in step with Settings. Called from the
 * store whenever a config frame lands. */
export function setSttStatus(status: SttStatus) {
  sttStatus = status;
}

let universal: UniversalSpeechEngine | null = null;
let cachedBridge: SpeechBridge | null = null;
let cachedFor: unknown = null;

function nativeBridge(ogb: NonNullable<Window["ogb"]>): SpeechBridge {
  return {
    kind: "native",
    start: (options) => ogb.speechStart(options),
    stop: () => ogb.speechStop(),
    finish: () => ogb.speechFinish?.() ?? Promise.resolve(),
    release: () => void ogb.speechStop(),
    onTranscript: (cb) => ogb.onSpeechTranscript(cb),
    onEnd: (cb) => ogb.onSpeechEnd(cb),
  };
}

function universalBridge(): SpeechBridge {
  universal ??= new UniversalSpeechEngine({ interim: () => Boolean(sttStatus?.interim) });
  const engine = universal;
  return {
    kind: "universal",
    start: (options) => engine.start(options),
    stop: () => engine.stop(),
    finish: () => engine.finish(),
    release: () => engine.release(),
    onTranscript: (cb) => engine.onTranscript(cb),
    onEnd: (cb) => engine.onEnd(cb),
  };
}

/** Whether this renderer uses the native macOS helper. */
export function usesNativeSpeech(): boolean {
  return typeof window !== "undefined" && window.ogb?.platform === "darwin" && typeof window.ogb.speechStart === "function";
}

/** The speech bridge for this renderer, or null outside the desktop app. */
export function speechBridge(): SpeechBridge | null {
  if (typeof window === "undefined" || !window.ogb) return null;
  // Keyed on the preload object so a replaced bridge (tests, a reloaded
  // preload) never keeps a stale choice.
  if (cachedBridge && cachedFor === window.ogb) return cachedBridge;
  cachedFor = window.ogb;
  cachedBridge = usesNativeSpeech() ? nativeBridge(window.ogb) : universalBridge();
  return cachedBridge;
}

type Dictation = DesktopCapabilities["dictation"];

/** Upgrade "unsupported-platform" to available when the harness has a
 * speech-recognition provider ready. Every other state (macOS native,
 * remote-server, desktop-app-required) passes through untouched. */
export function effectiveDictation(dictation: Dictation, stt: SttStatus): Dictation {
  if (dictation.available || dictation.reasonCode !== "unsupported-platform") return dictation;
  if (typeof window === "undefined" || !window.ogb || usesNativeSpeech()) return dictation;
  if (stt?.ready) return { available: true, engine: "universal", onDevice: stt.provider === "local" };
  return { ...dictation, reasonCode: "stt-setup-required" };
}

/** A user-facing note for universal-engine failures; null means "use the
 * caller's existing macOS wording". */
export function speechEndNote(info: SpeechEndInfo): string | null {
  if (!info.reason) return null;
  if (info.reason.startsWith("mic-") || info.reason.startsWith("stt-")) {
    return info.message ?? "Speech recognition stopped unexpectedly.";
  }
  return null;
}
