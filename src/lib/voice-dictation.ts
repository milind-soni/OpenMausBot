// Voice-note dictation — the button next to the send arrow, and the engine
// the "Luna" wake word drives.
//
// Difference from hold-to-dictate (clipboard-dictation.ts): there is no
// gesture to finalize, so END OF SPEECH has to be detected. Three signals
// cooperate, each covering the others' failure modes:
//   1. Deepgram's endpointer (speech_final) — the speaker finished a phrase.
//   2. A local silence watchdog — trailing RMS below threshold for ~600 ms
//      once an utterance was heard, so background noise cannot hold the mic
//      open forever and a missed endpointer still stops the recording.
//   3. A hard max-duration cap — a stuck session always ends, transcript or
//      not.
// While the bot is speaking (TTS) the session is SUSPENDED: frames are
// dropped and endpoint events ignored, the same half-duplex rule the call
// view uses, so the microphone never transcribes the bot's own voice.
//
// The event machine below is pure and unit-tested; the hook only wires
// browser audio and the bridge to it.

import { floatToPcm16 } from "./clipboard-dictation";

export type VoiceDictationPhase = "idle" | "starting" | "listening" | "finalizing";

export interface VoiceDictationState {
  phase: VoiceDictationPhase;
  /** Running transcript shown live (committed + interim). */
  partial: string;
  /** At least one endpointed utterance arrived — silence now means "done". */
  heardUtterance: boolean;
  /** Consecutive silent chunks since the last voiced one. */
  silentChunks: number;
  /** Monotonic ms timestamp of the start (0 while idle). */
  startedAt: number;
  error: string | null;
}

export const INITIAL_VOICE_DICTATION_STATE: VoiceDictationState = {
  phase: "idle",
  partial: "",
  heardUtterance: false,
  silentChunks: 0,
  startedAt: 0,
  error: null,
};

export type VoiceDictationEvent =
  | { type: "begin"; now: number }
  | { type: "opened" }
  | { type: "partial"; text: string }
  | { type: "utterance" }
  | { type: "level"; rms: number }
  | { type: "fail"; message: string }
  | { type: "stop"; now: number }
  | { type: "finish"; text: string }
  | { type: "reset" };

/** Silence tuning. RMS of PC float samples sits far below 1; ~0.01 is a
 * quiet room, speech peaks an order of magnitude past it. */
export const SILENCE_RMS_THRESHOLD = 0.01;
/** Consecutive silent chunks (256 ms each at 4096 frames / 16 kHz) that
 * count as "the speaker stopped" once an utterance was heard. */
export const SILENCE_CHUNKS_TO_STOP = 3;
/** The failsafe ceiling: dictation never runs past this, whatever happens. */
export const MAX_DICTATION_MS = 5 * 60 * 1000;

export function rmsOf(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) total += (samples[i] ?? 0) * (samples[i] ?? 0);
  return Math.sqrt(total / samples.length);
}

/** True when the watchdog should treat the current level as continued
 * silence. Background noise is what this threshold is for: a fan or street
 * sits under it, speech does not. */
export function isSilentLevel(rms: number): boolean {
  return rms < SILENCE_RMS_THRESHOLD;
}

/** Pure transition step. The hook reads the RESULT (not the event) to decide
 * side effects — a phase entering "finalizing" means flush Deepgram now. */
export function stepVoiceDictation(state: VoiceDictationState, event: VoiceDictationEvent): VoiceDictationState {
  switch (event.type) {
    case "begin":
      return { ...INITIAL_VOICE_DICTATION_STATE, phase: "starting", startedAt: event.now };
    case "opened":
      return state.phase === "starting" ? { ...state, phase: "listening" } : state;
    case "partial":
      return state.phase === "listening" || state.phase === "finalizing" ? { ...state, partial: event.text } : state;
    case "utterance":
      // The endpointer fired: an utterance was heard, silence now means done.
      return state.phase === "listening" ? { ...state, heardUtterance: true, silentChunks: 0 } : state;
    case "level": {
      if (state.phase !== "listening" || !state.heardUtterance) return state;
      if (isSilentLevel(event.rms)) {
        const silentChunks = state.silentChunks + 1;
        return { ...state, silentChunks };
      }
      return { ...state, silentChunks: 0 };
    }
    case "fail":
      return { ...state, phase: "idle", error: event.message, partial: "" };
    case "stop":
      if (state.phase !== "listening" && state.phase !== "starting") return state;
      return { ...state, phase: "finalizing" };
    case "finish":
      return { ...state, phase: "idle", partial: "", startedAt: 0 };
    case "reset":
      return { ...INITIAL_VOICE_DICTATION_STATE };
    default:
      return state;
  }
}

/** Whether the watchdog says auto-stop NOW: an utterance was heard, enough
 * consecutive silent chunks passed, and the hard cap has not lapsed (the cap
 * forces a stop regardless — enforced by shouldForceStop below). */
export function shouldAutoStop(state: VoiceDictationState): boolean {
  return state.phase === "listening" && state.heardUtterance && state.silentChunks >= SILENCE_CHUNKS_TO_STOP;
}

/** The last-resort failsafe: past MAX_DICTATION_MS the session stops even
 * without a detected endpoint, so a stuck mic can never stream forever. */
export function shouldForceStop(state: VoiceDictationState, now: number): boolean {
  return (state.phase === "listening" || state.phase === "finalizing") && now - state.startedAt > MAX_DICTATION_MS;
}

/** Where dictated text lands in the composer: appended after what the user
 * already typed, with one separating space on either side. Exported for the
 * wake-word flow, which must not clobber a half-written message. */
export function mergeDictatedText(base: string, dictated: string): string {
  const left = base.trimEnd();
  const right = dictated.trim();
  if (!right) return base;
  if (!left) return right;
  return `${left} ${right}`;
}

const PCM_SAMPLE_RATE = 16000;
const PCM_CHUNK_FRAMES = 4096;

export interface VoiceDictationCallbacks {
  /** Live transcript (committed + interim). */
  onPartial?: (text: string) => void;
  /** The final transcript, once the session ends (stop, auto-stop or cap). */
  onResult: (text: string) => void;
  onError: (message: string) => void;
  /** Recording indicator for the pill/button. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Drives one voice-note dictation session. Returns null when the bridge
 * lacks the dictation surface (browser/dev shells).
 */
export function createVoiceDictationSession(callbacks: VoiceDictationCallbacks) {
  const bridge = window.ogb;
  if (!bridge?.dictation) return null;
  // A captured narrowed alias: closures below outlive the type narrowing at
  // the check above, so every dictation call goes through `d`.
  const d = bridge.dictation;

  let state: VoiceDictationState = INITIAL_VOICE_DICTATION_STATE;
  let disposed = false;
  let suspended = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let sessionId: number | null = null;
  let finalizeInFlight = false;
  let silenceTimer: number | undefined;
  let offOpen: (() => void) | null = null;
  let offPartial: (() => void) | null = null;
  let offUtterance: (() => void) | null = null;
  let offError: (() => void) | null = null;

  const emit = () => callbacks.onActiveChange?.(state.phase === "listening" || state.phase === "starting");

  const dispatch = (event: VoiceDictationEvent) => {
    if (disposed) return;
    const before = state;
    state = stepVoiceDictation(state, event);
    if (state === before) return;
    if (before.partial !== state.partial) callbacks.onPartial?.(state.partial);
    if ((before.phase === "listening" || before.phase === "starting") !== (state.phase === "listening" || state.phase === "starting")) emit();
    if (state.phase === "finalizing" && before.phase !== "finalizing") void finalize();
    if (shouldAutoStop(state)) stop();
    if (shouldForceStop(state, Date.now())) stop();
  };

  const scheduleCapCheck = () => {
    window.clearInterval(silenceTimer);
    // The interval serves both the watchdog countdown bookkeeping (chunks
    // come from audio events, not the clock) and the max-duration check.
    silenceTimer = window.setInterval(() => {
      if (shouldForceStop(state, Date.now())) stop();
    }, 1000);
  };

  const cleanupAudio = () => {
    window.clearInterval(silenceTimer);
    try {
      processor?.disconnect();
    } catch {}
    processor = null;
    void context?.close().catch(() => {});
    context = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const finalize = async () => {
    if (finalizeInFlight) return;
    finalizeInFlight = true;
    const id = sessionId;
    sessionId = null;
    cleanupAudio();
    const text = id !== null ? await d.finish(id).catch(() => "") : "";
    finalizeInFlight = false;
    if (disposed) return;
    offPartial?.();
    offUtterance?.();
    offError?.();
    offOpen?.();
    offPartial = offUtterance = offError = offOpen = null;
    dispatch({ type: "finish", text });
    const finalText = text.trim();
    if (finalText) callbacks.onResult(finalText);
    else callbacks.onError("Nothing was picked up — try speaking a little louder.");
  };

  /** Manual stop, wake-word stop, or the watchdog: begin finalization. */
  const stop = () => dispatch({ type: "stop", now: Date.now() });

  const pump = (input: Float32Array) => {
    if (disposed || state.phase !== "listening") return;
    if (suspended) return; // the bot is talking: drop frames (half-duplex)
    dispatch({ type: "level", rms: rmsOf(input) });
    if (sessionId === null) return;
    const pcm = floatToPcm16(input);
    void d.audio(sessionId, pcm).catch(() => {});
  };

  const start = async () => {
    dispatch({ type: "begin", now: Date.now() });
    scheduleCapCheck();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const id = await d.start();
      if (disposed) {
        void d.cancel(id).catch(() => {});
        return;
      }
      sessionId = id;
      context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      const source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(PCM_CHUNK_FRAMES, 1, 1);
      processor.onaudioprocess = (event) => pump(event.inputBuffer.getChannelData(0));
      source.connect(processor);
      // Capture must never reach the speakers; a muted sink keeps the graph
      // pulling while the processor reads the input side directly.
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(context.destination);

      offOpen = d.onOpen((openId) => {
        if (openId === sessionId) dispatch({ type: "opened" });
      });
      offPartial = d.onPartial((id2, text) => {
        if (id2 === sessionId) dispatch({ type: "partial", text });
      });
      offUtterance = d.onUtterance((id2) => {
        if (id2 === sessionId && !suspended) dispatch({ type: "utterance" });
      });
      offError = d.onError((id2, message) => {
        if (id2 === sessionId) dispatch({ type: "fail", message });
      });
    } catch (error) {
      cleanupAudio();
      sessionId = null;
      const message = error instanceof Error ? error.message : String(error);
      dispatch({
        type: "fail",
        message: /permission|denied/i.test(message)
          ? "Microphone access was denied — allow it, then press the mic again."
          : /No Deepgram key/i.test(message)
            ? message
            : "Could not reach the transcription stream. Check your Deepgram key and connection.",
      });
      callbacks.onError(state.error ?? message);
    }
  };

  return {
    /** Open the mic and begin capturing. The hook/wake session calls this
     * once; auto-stop, manual stop and the cap go through stop(). */
    start,
    /** Live state (for the pill). */
    get state(): VoiceDictationState {
      return state;
    },
    /** Mute the mic while the bot speaks; frames and endpoints are ignored. */
    setSuspended(next: boolean) {
      suspended = next;
    },
    stop,
    dispose() {
      disposed = true;
      window.clearInterval(silenceTimer);
      offPartial?.();
      offUtterance?.();
      offError?.();
      offOpen?.();
      const id = sessionId;
      sessionId = null;
      if (id !== null) void d.cancel(id).catch(() => {});
      cleanupAudio();
      state = { ...INITIAL_VOICE_DICTATION_STATE };
    },
  };
}
