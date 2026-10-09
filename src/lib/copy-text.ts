import { useCallback, useEffect, useRef, useState } from "react";

/** What a copy attempt did. "empty" means nothing was written, so the user's
 * existing clipboard is left alone. */
export type CopyResult = "copied" | "empty" | "failed";
export type CopyFeedback = "idle" | "copied" | "failed";

/** How long the success/failure mark stays before the icon is restored. */
export const COPY_FEEDBACK_MS = 1200;

/** How long the web Clipboard write may stay unsettled before the desktop
 * bridge is tried. Chromium rejects an unfocused write at once; this only
 * bounds a write that never settles at all. */
export const WEB_WRITE_TIMEOUT_MS = 3000;

/** Resolves true when the web write succeeds, false when it rejects, throws,
 * is unavailable or is still unsettled after WEB_WRITE_TIMEOUT_MS. A late
 * settlement is ignored, and its rejection is handled here. */
function writeWeb(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WEB_WRITE_TIMEOUT_MS);
    try {
      if (!navigator.clipboard?.writeText) return finish(false);
      Promise.resolve(navigator.clipboard.writeText(text)).then(() => finish(true), () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * Writes `text` to the clipboard and says whether it landed. The web
 * Clipboard API is tried first; it rejects when the page is not focused, the
 * permission is denied, or the context is insecure (where `navigator.clipboard`
 * is absent), and a write that never settles times out. Only then does the
 * desktop bridge's explicit clipboard channel run, when the shell provides it.
 * Never throws.
 */
export async function copyText(text: string): Promise<CopyResult> {
  if (!text.trim()) return "empty";
  if (await writeWeb(text)) return "copied";
  try {
    if (typeof window !== "undefined" && (await window.ogb?.copyText?.(text)) === true) return "copied";
  } catch {
    // both mechanisms failed
  }
  return "failed";
}

interface CopyFeedbackOptions {
  copy: (text: string) => Promise<CopyResult>;
  onChange: (state: CopyFeedback) => void;
  resetMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Framework-free state machine behind the copy button: one write in flight
 * at a time, a result mark that resets itself, and no updates after dispose. */
export function createCopyFeedback({
  copy,
  onChange,
  resetMs = COPY_FEEDBACK_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: CopyFeedbackOptions) {
  let pending = false;
  let disposed = false;
  let timer: unknown;

  const clear = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  return {
    /** Resolves once the attempt settles; a click while one is in flight is ignored. */
    async click(text: string): Promise<CopyResult | "busy"> {
      if (pending) return "busy";
      pending = true;
      let result: CopyResult;
      try {
        result = await copy(text);
      } catch {
        result = "failed";
      } finally {
        pending = false;
      }
      if (disposed || result === "empty") return result;
      clear();
      onChange(result === "copied" ? "copied" : "failed");
      timer = setTimer(() => {
        timer = undefined;
        onChange("idle");
      }, resetMs);
      return result;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

/** React binding: `state` drives the icon, `copy()` is safe to wire to onClick. */
export function useCopyFeedback(text: string) {
  const [state, setState] = useState<CopyFeedback>("idle");
  const controller = useRef<ReturnType<typeof createCopyFeedback> | null>(null);
  useEffect(() => {
    const next = createCopyFeedback({ copy: copyText, onChange: setState });
    controller.current = next;
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, []);
  const copy = useCallback(() => void controller.current?.click(text), [text]);
  return { state, copy };
}
