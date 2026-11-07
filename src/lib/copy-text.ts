import { useCallback, useEffect, useRef, useState } from "react";

export type CopyResult = "copied" | "empty" | "failed";
export type CopyFeedback = "idle" | "copied" | "failed";

export const COPY_FEEDBACK_MS = 1200;

/** Bounds a web write that never settles; Chromium rejects an unfocused write at once. */
export const WEB_WRITE_TIMEOUT_MS = 3000;

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
 * Legacy execCommand fallback: on insecure-context (plain-LAN-HTTP) mobile
 * browsers `navigator.clipboard` is undefined and only the classic
 * select-then-copy path works. No-op outside a real DOM.
 */
function writeLegacy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Web Clipboard API, then legacy execCommand (insecure-context mobile), then the desktop bridge. Never throws. */
export async function copyText(text: string): Promise<CopyResult> {
  if (!text.trim()) return "empty";
  if (await writeWeb(text)) return "copied";
  if (writeLegacy(text)) return "copied";
  try {
    if (typeof window !== "undefined" && (await window.ogb?.copyText?.(text)) === true) return "copied";
  } catch {
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
