// The "Astra" wake word driving Handy (https://handy.computer) — the user's
// own OFFLINE speech-to-text app.
//
// The user's flow, automated end to end:
//   "Astra" → Handy toggles into recording → the user talks → silence stops
//   it (watchdog below) → the pill animates while Handy transcribes → the
//   transcript lands on the CLIPBOARD (the user's Handy is in clipboard
//   mode) → it feeds into the composer.
//
// Divisions of labor:
//   - Handy owns recording, the Whisper model, decoding, and (in its
//     clipboard mode) writing the result. We never touch its audio.
//   - We own START (Porcupine fired → spawn `Handy --toggle-transcription`)
//     and STOP (the user's own silence watchdog — Handy has no status IPC
//     yet, so nothing tells it "they stopped talking"), then detect the
//     transcript as a clipboard CHANGE against a snapshot taken BEFORE
//     recording began.
//
// Everything here is on-device: Porcupine and Handy both run locally. No
// Deepgram key is involved in this flow.
import { rmsOf } from "./voice-dictation";
import { handyPath } from "./handy";

export const SILENCE_RMS_THRESHOLD = 0.01;
/** Consecutive silent frames (256 ms each) that mean "the speaker stopped".
 * Two is about half a second — a natural gap without chopping mid-speech. */
export const SILENCE_FRAMES_TO_STOP = 2;
/** Handy has no status IPC; a toggle that produced no recording would
 * otherwise wedge the session. Generous, because a first-load of the
 * Whisper model can trail the toggle by a while. */
export const MAX_RECORDING_MS = 2 * 60 * 1000;
/** Clipboard wait ceiling: transcription of a short utterance is seconds. */
export const MAX_CLIPBOARD_WAIT_MS = 30_000;
/** How often the clipboard is sampled while waiting for Handy. */
export const CLIPBOARD_POLL_MS = 250;
/** Stands in for "the clipboard was empty before we started" — an empty
 * string is a real clipboard state, so it needs its own marker. */
export const EMPTY_CLIPBOARD_SENTINEL = "__OMB_EMPTY_CLIPBOARD__";

export function isSilentFrame(samples: ArrayLike<number>): boolean {
  return rmsOf(samples) < SILENCE_RMS_THRESHOLD;
}

/** Pure watchdog step: count consecutive silent frames, reset on voice. */
export function stepSilence(framesSilent: number, silent: boolean): number {
  return silent ? framesSilent + 1 : 0;
}

export function shouldStopRecording(framesSilent: number): boolean {
  return framesSilent >= SILENCE_FRAMES_TO_STOP;
}

/** The snapshot Handy will overwrite: whatever was on the clipboard before
 * recording started, or the sentinel if it was empty. */
export function baselineText(clipboard: string): string {
  return clipboard === "" ? EMPTY_CLIPBOARD_SENTINEL : clipboard;
}

/** The transcript Handy left: the clipboard changed (and, coming from the
 * empty sentinel, is no longer empty — Handy never transcribes to ""). */
export function extractTranscript(baseline: string, current: string): string {
  if (current === baseline) return "";
  if (baseline === EMPTY_CLIPBOARD_SENTINEL && current === "") return "";
  return current;
}

export interface HandySessionCallbacks {
  /** Recording started (Handy accepted the toggle). */
  onRecording?: () => void;
  /** Recording ended; transcription now runs inside Handy. */
  onTranscribing?: () => void;
  /** The transcript landed on the clipboard. */
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onActiveChange: (active: boolean) => void;
}

type Phase = "idle" | "starting" | "recording" | "transcribing";

/**
 * One wake→Handy→clipboard cycle. Null when the bridge lacks the toggle
 * surface (browser/dev shells).
 */
export function createHandyDictationSession(callbacks: HandySessionCallbacks) {
  const bridge = window.ogb;
  if (!bridge?.handyToggle || !bridge.readClipboardText) return null;

  let disposed = false;
  let suspended = false;
  let phase: Phase = "idle";
  let baseline = EMPTY_CLIPBOARD_SENTINEL;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let framesSilent = 0;
  let heardVoice = false;
  let pollTimer: number | undefined;
  let capTimer: number | undefined;

  const setPhase = (next: Phase) => {
    const wasActive = phase !== "idle";
    phase = next;
    if ((next !== "idle") !== wasActive) callbacks.onActiveChange(next !== "idle");
  };

  // TS narrows the `phase` variable at the top of start() and cannot see
  // setPhase() mutate it across awaits; every in-closure check goes through
  // this indirection so the guard's narrowing never leaks in.
  const phaseIs = (wanted: Phase): boolean => phase === wanted;

  const clearTimers = () => {
    window.clearInterval(pollTimer);
    window.clearTimeout(capTimer);
    pollTimer = undefined;
    capTimer = undefined;
  };

  const cleanupMic = () => {
    try {
      processor?.disconnect();
    } catch {}
    processor = null;
    void context?.close().catch(() => {});
    context = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const fail = (message: string) => {
    if (phase === "idle" || disposed) return;
    cleanupMic();
    clearTimers();
    setPhase("idle");
    callbacks.onError(message);
  };

  /** Toggle Handy off, then poll the clipboard for the transcript. */
  const stopAndCollect = () => {
    if (phase !== "recording") return;
    setPhase("transcribing");
    cleanupMic();
    callbacks.onTranscribing?.();
    void bridge.handyToggle!(handyPath()).then((result) => {
      if (disposed) return;
      if (!result.ok) {
        fail(`Could not stop Handy: ${result.error ?? "unknown error"}`);
        return;
      }
      const deadline = Date.now() + MAX_CLIPBOARD_WAIT_MS;
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => {
        if (disposed || phase !== "transcribing") return;
        void bridge.readClipboardText!().then((current) => {
          if (disposed || phase !== "transcribing") return;
          const transcript = extractTranscript(baseline, current ?? "");
          if (transcript) {
            clearTimers();
            setPhase("idle");
            callbacks.onTranscript(transcript);
          } else if (Date.now() > deadline) {
            fail("Handy did not produce a transcript in time.");
          }
        }).catch(() => {});
      }, CLIPBOARD_POLL_MS);
      capTimer = window.setTimeout(() => {
        if (phase === "transcribing") fail("Handy did not produce a transcript in time.");
      }, MAX_CLIPBOARD_WAIT_MS);
    });
  };

  const start = () => {
    if (phase !== "idle" || disposed || suspended) return;
    setPhase("starting");
    void (async () => {
      // Snapshot the clipboard BEFORE Handy records: Handy's clipboard mode
      // replaces it with the transcript, so the change IS the result.
      const before = await bridge.readClipboardText!().catch(() => "");
      // dispose() calls setPhase("idle") — checked via phaseIs because the
      // guard's narrowing cannot see the mutation across awaits.
      if (disposed || !phaseIs("starting")) return;
      baseline = baselineText(before ?? "");
      const toggle = await bridge.handyToggle!(handyPath());
      if (disposed || !phaseIs("starting")) return;
      if (!toggle.ok) {
        setPhase("idle");
        callbacks.onError(`Could not start Handy: ${toggle.error ?? "not found"}. Set its path in Settings → Wake word.`);
        return;
      }
      if (suspended) {
        // The bot started speaking (or a call opened) mid-start; stand down.
        void bridge.handyToggle!(handyPath());
        setPhase("idle");
        return;
      }
      // Parallel mic stream ONLY as a silence detector: frames are compared
      // against a threshold and dropped — nothing is recorded, stored, or
      // sent anywhere (Handy's recorder runs independently).
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (disposed) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        context = new AudioContext({ sampleRate: 16000 });
        const source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          if (phase !== "recording" || suspended) return;
          const silent = isSilentFrame(event.inputBuffer.getChannelData(0));
          if (!silent) {
            heardVoice = true;
            framesSilent = 0;
            return;
          }
          framesSilent = stepSilence(framesSilent, true);
          if (heardVoice && shouldStopRecording(framesSilent)) stopAndCollect();
        };
        source.connect(processor);
        const mute = context.createGain();
        mute.gain.value = 0;
        processor.connect(mute);
        mute.connect(context.destination);
      } catch {
        // No parallel mic (or permission refused): Handy still records —
        // the user just stops it themselves, exactly as they do today.
      }
      setPhase("recording");
      callbacks.onRecording?.();
      capTimer = window.setTimeout(() => {
        // The watchdog never fired (no voice, or pure noise): stop rather
        // than leave Handy recording forever.
        if (phase === "recording") stopAndCollect();
      }, MAX_RECORDING_MS);
    })();
  };

  return {
    get phase(): Phase {
      return phase;
    },
    start,
    /** The bot speaks or a call opens: arm suspension; the watchdog ignores
     * frames while suspended and a mid-start toggle stands down. */
    setSuspended(next: boolean) {
      suspended = next;
    },
    get suspended(): boolean {
      return suspended;
    },
    stop: () => {
      if (phase === "recording") stopAndCollect();
    },
    dispose() {
      disposed = true;
      clearTimers();
      cleanupMic();
      setPhase("idle");
    },
  };
}
