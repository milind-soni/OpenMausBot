import { useEffect, useRef, useState } from "react";

import {
  DICTATION_UNAVAILABLE,
  createDictationCapture,
  dictationCaptureAvailable,
  type DictationCapture,
} from "./dictation-capture";

type ModifierEvent = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "repeat">;

/** Ctrl+Space, and only that: no other modifiers, not an auto-repeat, so the
 * gesture never collides with the shortcuts the app already owns. */
export function isDictationPress(event: ModifierEvent): boolean {
  return (
    event.code === "Space" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat
  );
}

/** While a hold is active, releasing Space or either Control finalizes —
 * the user may let go of the combo in either order. */
export function isDictationRelease(event: ModifierEvent): boolean {
  return event.code === "Space" || event.code === "ControlLeft" || event.code === "ControlRight";
}

/**
 * Hold Ctrl+Space to dictate; release to transcribe.
 *
 * The mic is held open only while the keys are down, and the audio is
 * decoded on this machine by the user's own Handy install — nothing is
 * uploaded, no key is involved, and there is no streaming socket. The hold
 * IS the endpoint, so there is no endpointer here. Escape discards the hold,
 * and a focus steal finalizes whatever was captured rather than wedging the
 * mic open.
 */
export function useClipboardDictation(
  onResult: (text: string) => void,
  onError: (message: string) => void,
  onTranscribing?: () => void,
): boolean {
  const [active, setActive] = useState(false);
  const callbacks = useRef({ onResult, onError, onTranscribing });
  callbacks.current = { onResult, onError, onTranscribing };

  useEffect(() => {
    if (!dictationCaptureAvailable()) return;
    let mounted = true;
    let current: { capture: DictationCapture; ready: boolean; finishing: boolean; failed: boolean } | null = null;
    // A cancelled decode still occupies Handy until its promise settles.
    let decoding = false;

    const cancel = () => {
      const session = current;
      current = null;
      session?.capture.discard();
      if (mounted) setActive(false);
    };
    const finalize = () => {
      const session = current;
      if (!session || session.finishing) return;
      if (!session.ready) {
        cancel();
        return;
      }
      session.finishing = true;
      decoding = true;
      callbacks.current.onTranscribing?.();
      void session.capture.transcribe().then((text) => {
        if (!mounted || current !== session) return;
        current = null;
        setActive(false);
        if (session.failed) return;
        if (text) callbacks.current.onResult(text);
        else callbacks.current.onError("Nothing was picked up — hold Ctrl+Space and speak.");
      }).catch(() => {
        if (!mounted || current !== session) return;
        current = null;
        setActive(false);
        if (!session.failed) callbacks.current.onError("Handy transcription failed.");
      }).finally(() => { decoding = false; });
    };
    const begin = async () => {
      const capture = createDictationCapture({
        onAutoStop: finalize,
        onError: (message) => {
          if (!mounted || current?.capture !== capture) return;
          current.failed = true;
          callbacks.current.onError(message);
        },
      });
      if (!capture) {
        callbacks.current.onError(DICTATION_UNAVAILABLE);
        return;
      }
      const session = { capture, ready: false, finishing: false, failed: false };
      current = session;
      setActive(true);
      try {
        await capture.start();
        if (!mounted || current !== session) {
          capture.discard();
          return;
        }
        session.ready = true;
      } catch (error) {
        capture.discard();
        if (!mounted || current !== session) return;
        current = null;
        setActive(false);
        const message = error instanceof Error ? error.message : String(error);
        callbacks.current.onError(
          /permission|denied/i.test(message)
            ? "Microphone access was denied — allow it, then hold Ctrl+Space again."
            : "The microphone could not start. Check Microphone access, then try again.",
        );
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && current) {
        event.preventDefault();
        cancel();
      } else if (!current && !decoding && isDictationPress(event)) {
        event.preventDefault();
        void begin();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (current && isDictationRelease(event)) {
        event.preventDefault();
        finalize();
      }
    };
    const onBlur = () => finalize();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      mounted = false;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      cancel();
    };
  }, []);

  return active;
}

