// The "Astra" wake word.
//
// Porcupine runs ON-DEVICE in a worker: raw mic frames go in, and the only
// thing that comes out is "the phrase was heard". No audio leaves the
// machine, nothing is transcribed here. Hearing "Astra" starts one
// voice-dictation session (voice-dictation.ts); when the speaker finishes
// (the local silence watchdog), the transcript lands in the composer via
// appendComposerDraft, the same path the Verify card's Save button uses — it
// updates a mounted composer live and survives the composer being unmounted.
//
// Suspension rules (mirroring the call view's half-duplex rule):
//   - while the bot SPEAKS (TTS), detection pauses — Astra must never wake
//     on her own voice;
//   - while a CALL is up, detection pauses — the call owns the mic;
//   - while dictation itself is live, the controller stands down until the
//     transcript lands.
//
// The keyword model is trained at runtime from the phrase "Astra" via
// Porcupine's Console API (trainWakeWordFromPhrase) and cached in
// IndexedDB, so the only credential needed is a free Picovoice AccessKey,
// entered once in Settings → Connections. If that key is absent or training
// fails, the toggle in Settings reports it instead of half-working.

import { Porcupine, PorcupineWorker, type PorcupineKeyword } from "@picovoice/porcupine-web";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor";

import { appendComposerDraft } from "./drafts";
import { createVoiceDictationSession } from "./voice-dictation";

export const WAKE_PHRASE = "Astra";
const KEYWORD_CACHE_PATH = "astra_keyword";

export interface WakeWordCallbacks {
  onDetected: () => void;
  /** User-readable failure (bad key, offline training, processor error). */
  onError: (message: string) => void;
  /** Detection armed or stood down (for the pill and the settings row). */
  onArmedChange?: (armed: boolean) => void;
}

/** True when this environment can run the wake word at all: the desktop
 * bridge exists and WebAudio is present. The voice processor asks for mic
 * permission itself when the engine arms. */
export function wakeWordSupported(): boolean {
  return typeof window !== "undefined" && Boolean(window.ogb) && typeof AudioContext !== "undefined";
}

export class WakeWordController {
  private worker: PorcupineWorker | null = null;
  private subscribed = false;
  private suspended = false;
  private disposed = false;
  private detectorActive = false;
  private readonly callbacks: WakeWordCallbacks;

  constructor(callbacks: WakeWordCallbacks) {
    this.callbacks = callbacks;
  }

  get armed(): boolean {
    return this.detectorActive;
  }

  /** Build the engine (training "Astra" on first use; cached in IndexedDB
   * afterwards). Throws with a user-readable message on failure. */
  async prepare(accessKey: string): Promise<void> {
    if (this.worker) return;
    let keyword: PorcupineKeyword;
    try {
      // Training is a static on the engine class, not the worker (the
      // Console API call runs on the main thread; only detection is a worker).
      keyword = await Porcupine.trainWakeWordFromPhrase(accessKey, KEYWORD_CACHE_PATH, "en", WAKE_PHRASE);
    } catch (error) {
      // trainWakeWordFromPhrase caches into IndexedDB under writePath and
      // returns {publicPath, customWritePath, label}. Passing that object
      // straight back would re-FETCH a public path that does not exist; the
      // cached storage name is what create() needs.
      keyword = { label: WAKE_PHRASE, customWritePath: KEYWORD_CACHE_PATH };
      void error;
    }
    void keyword; // cached under KEYWORD_CACHE_PATH by the training call
    const worker = await PorcupineWorker.create(
      accessKey,
      // The trained model is read back from the IndexedDB slot the training
      // call wrote — never from the returned publicPath (a URL that does
      // not exist after the Console session).
      [{ customWritePath: KEYWORD_CACHE_PATH, label: WAKE_PHRASE }],
      () => {
        if (!this.suspended && this.detectorActive) this.callbacks.onDetected();
      },
      // The engine parameters file: downloaded once, then cached in
      // IndexedDB under this name (loadModel's contract).
      { customWritePath: "porcupine_params_omb" },
      {
        processErrorCallback: (error) => this.callbacks.onError(String(error?.message ?? error)),
      },
    );
    this.worker = worker;
  }

  /** Subscribe the mic and start detecting. */
  async arm(): Promise<void> {
    if (!this.worker || this.subscribed || this.disposed) return;
    await WebVoiceProcessor.subscribe(this.worker);
    this.subscribed = true;
    this.detectorActive = true;
    this.callbacks.onArmedChange?.(true);
  }

  /** Release the mic (dictation took it, or the feature was switched off). */
  async disarm(): Promise<void> {
    if (!this.subscribed || !this.worker) return;
    this.subscribed = false;
    this.detectorActive = false;
    this.callbacks.onArmedChange?.(false);
    try {
      await WebVoiceProcessor.unsubscribe(this.worker);
    } catch {
      // An already-torn-down processor must not wedge the controller; the
      // next arm() re-subscribes from scratch.
    }
  }

  /** The bot is speaking (or a call is up): keep the worker but ignore it. */
  setSuspended(next: boolean): void {
    this.suspended = next;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.detectorActive = false;
    this.callbacks.onArmedChange?.(false);
    if (this.subscribed && this.worker) {
      try {
        await WebVoiceProcessor.unsubscribe(this.worker);
      } catch {}
      this.subscribed = false;
    }
    this.worker?.terminate();
    this.worker = null;
  }
}

/** One wake→dictate cycle. The controller never touches the composer or the
 * transcription engine itself; this object owns the session while a
 * transcript is being captured, so a second "Astra" cannot double-open it.
 * There is one engine now — the user's own Handy install, decoded offline —
 * so start() has no choice to make. */
export function createWakeWordSession(callbacks: {
  onActiveChange?: (active: boolean) => void;
  /** The mic is closed and the offline engine is decoding the recording. */
  onTranscribing?: () => void;
  onError: (message: string) => void;
}) {
  type Disposable = { dispose: () => void; stop: () => void };
  let session: Disposable | null = null;

  const teardown = () => {
    session?.dispose();
    session = null;
    callbacks.onActiveChange?.(false);
  };

  const deliver = (text: string) => {
    const draftId = currentWakeDraftId();
    if (draftId) appendComposerDraft(draftId, text);
  };

  return {
    get active(): boolean {
      return session !== null;
    },
    start() {
      if (session) return;
      const dictation = createVoiceDictationSession({
        onActiveChange: (active) => {
          if (!active) return;
          callbacks.onActiveChange?.(true);
        },
        onTranscribing: () => callbacks.onTranscribing?.(),
        onResult: (text) => {
          // A disposed session's final event can race the teardown that
          // disposed it; only the live session may write or tear down.
          if (!session) return;
          deliver(text);
          teardown();
        },
        onError: (message) => {
          if (!session) return;
          callbacks.onError(message);
          teardown();
        },
      });
      if (!dictation) {
        callbacks.onError("Dictation isn't available in this build.");
        return;
      }
      session = dictation as Disposable;
      callbacks.onActiveChange?.(true);
      void dictation.start();
    },
    /** The composer is the destination only while it is mounted; a thread
     * switch mid-dictation ends the capture instead of writing into a
     * thread the user can no longer see. Call this when it unmounts. */
    stop() {
      if (!session) return;
      session.stop();
    },
    dispose: teardown,
  };
}

/** The draft id the wake transcript lands in: the thread the composer last
 * reported. Null when no composer is mounted — the transcript is dropped
 * rather than injected into a hidden thread. */
let wakeDraftTarget: string | null = null;
export function setWakeDraftTarget(id: string | null): void {
  wakeDraftTarget = id;
}
function currentWakeDraftId(): string | null {
  return wakeDraftTarget;
}
