// Voice-note dictation — the button next to the send arrow, and the engine
// the "Astra" wake word drives.
//
// Difference from hold-to-dictate (clipboard-dictation.ts): there is no
// gesture to finalize, so END OF SPEECH has to be detected. Two signals
// cooperate, each covering the other's failure mode:
//   1. A local silence watchdog — trailing RMS below threshold for ~600 ms
//      once speech was heard. It is the ONLY endpointer here: the offline
//      engine decodes a finished file, so nothing remote reports an endpoint.
//   2. A hard max-duration cap — a stuck session always ends, transcript or
//      not.
// While the bot is speaking (TTS) the session is SUSPENDED: frames are
// dropped, the same half-duplex rule the call view uses, so the microphone
// never transcribes the bot's own voice.
//
// The event machine below is pure and unit-tested; the hook only wires
// browser audio and the offline transcriber to it.

import { DICTATION_UNAVAILABLE, createDictationCapture, type DictationCapture } from "./dictation-capture";

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
 * side effects — a phase entering "finalizing" means transcribe now. */
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

export interface VoiceDictationCallbacks {
  /** The final transcript, once the session ends (stop, auto-stop or cap). */
  onResult: (text: string) => void;
  onError: (message: string) => void;
  /** Recording indicator for the pill/button. */
  onActiveChange?: (active: boolean) => void;
  /** Finalization began: the mic is closed and the offline engine is decoding
   * the recording. It takes a beat on a cold model, so the UI can say so. */
  onTranscribing?: () => void;
}

/**
 * Drives one voice-note dictation session on the offline engine.
 *
 * The audio path is the same one hold-to-dictate uses: frames are captured
 * here and decoded on this machine by the user's own Handy install. Because
 * Handy decodes a finished file rather than a stream, `heardUtterance` — the
 * flag the silence watchdog waits on before it may end a turn — is set from
 * the LOCAL level signal instead of a remote endpoint event. Everything above
 * (the transitions, the auto-stop rules, the 5-minute cap) is unchanged, so
 * the timing behaves exactly as it did with a streaming recognizer.
 *
 * Returns null when the bridge lacks the transcription surface (browser and
 * dev shells), which the caller reports rather than silently doing nothing.
 */
export function createVoiceDictationSession(callbacks: VoiceDictationCallbacks) {
  let state: VoiceDictationState = INITIAL_VOICE_DICTATION_STATE;
  let disposed = false;
  let suspended = false;
  let capture: DictationCapture | null = null;
  let finalizeInFlight = false;
  let capTimer: number | undefined;

  const emit = () => callbacks.onActiveChange?.(state.phase === "listening" || state.phase === "starting");

  const dispatch = (event: VoiceDictationEvent) => {
    if (disposed) return;
    const before = state;
    state = stepVoiceDictation(state, event);
    if (state === before) return;
    const wasLive = before.phase === "listening" || before.phase === "starting";
    const isLive = state.phase === "listening" || state.phase === "starting";
    if (wasLive !== isLive) emit();
    if (state.phase === "finalizing" && before.phase !== "finalizing") void finalize();
    if (shouldAutoStop(state)) stop();
    if (shouldForceStop(state, Date.now())) stop();
  };

  /** Manual stop, wake-word stop, or the watchdog: begin finalization. */
  const stop = () => {
    if (state.phase === "starting") {
      capture?.discard();
      capture = null;
      dispatch({ type: "reset" });
      return;
    }
    dispatch({ type: "stop", now: Date.now() });
  };

  const finalize = async () => {
    if (finalizeInFlight) return;
    finalizeInFlight = true;
    const active = capture;
    window.clearInterval(capTimer);
    capTimer = undefined;
    if (!active) {
      finalizeInFlight = false;
      return;
    }
    callbacks.onTranscribing?.();
    try {
      const text = await active.transcribe();
      if (disposed || capture !== active || state.error) return;
      dispatch({ type: "finish", text });
      const finalText = text.trim();
      if (finalText) callbacks.onResult(finalText);
      else callbacks.onError("Nothing was picked up — try speaking a little louder.");
    } catch {
      if (!disposed && capture === active && !state.error) {
        dispatch({ type: "fail", message: "Handy transcription failed." });
        callbacks.onError("Handy transcription failed.");
      }
    } finally {
      finalizeInFlight = false;
      if (capture === active) capture = null;
    }
  };

  const start = async () => {
    if (disposed || state.phase !== "idle" || finalizeInFlight) return;
    dispatch({ type: "begin", now: Date.now() });
    if (disposed) return;
    let session: DictationCapture | null = null;
    try {
      session = createDictationCapture({
        // No endpointerFrames: the watchdog above owns "the speaker stopped",
        // so the tested silence rules stay the single source of truth. The
        // capture's own memory ceiling still reports through onAutoStop.
        onAutoStop: () => stop(),
        onLevel: (level) => {
          if (disposed || suspended) return;
          // First speech of this session: silence now means "done" — the
          // signal a streaming recognizer's endpointer used to supply.
          if (level.hasSpeech && !state.heardUtterance) dispatch({ type: "utterance" });
          dispatch({ type: "level", rms: level.rms });
        },
        onError: (message) => {
          if (!disposed && capture === session) {
            dispatch({ type: "fail", message });
            callbacks.onError(message);
          }
        },
      });
      if (!session) {
        dispatch({ type: "fail", message: DICTATION_UNAVAILABLE });
        callbacks.onError(DICTATION_UNAVAILABLE);
        return;
      }
      capture = session;
      session.setMuted(suspended);
      await session.start();
      if (disposed || capture !== session) {
        session.discard();
        return;
      }
      dispatch({ type: "opened" });
      // The interval only checks the cap; the silence countdown is driven by
      // audio frames, not the clock.
      capTimer = window.setInterval(() => {
        if (shouldForceStop(state, Date.now())) stop();
      }, 1000);
    } catch (error) {
      if (capture !== session) return;
      capture = null;
      window.clearInterval(capTimer);
      capTimer = undefined;
      const message = error instanceof Error ? error.message : String(error);
      const failure = /permission|denied/i.test(message)
        ? "Microphone access was denied — allow it, then press the mic again."
        : "The microphone could not start. Check Microphone access, then try again.";
      dispatch({ type: "fail", message: failure });
      callbacks.onError(failure);
    }
  };

  return {
    /** Live state (for the pill). */
    get state(): VoiceDictationState {
      return state;
    },
    /** Open the mic and begin capturing. The auto-stop, the manual stop and
     * the cap all funnel through stop(). */
    start,
    /** The bot speaks: stop counting silence and drop frames, so its own
     * voice can neither end the user's turn nor land in the recording. */
    setSuspended(next: boolean) {
      suspended = next;
      capture?.setMuted(next);
    },
    stop,
    dispose() {
      disposed = true;
      window.clearInterval(capTimer);
      capture?.discard();
      capture = null;
      state = { ...INITIAL_VOICE_DICTATION_STATE };
    },
  };
}
