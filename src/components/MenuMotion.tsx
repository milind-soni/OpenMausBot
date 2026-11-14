import { useLayoutEffect, useRef, useState } from "react";

/** Same length as `--animate-pop-in` in styles.css. */
export const MENU_MOTION_MS = 200;

function reducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface MenuMotion {
  shown: boolean;
  closing: boolean;
  className: string;
  exitProps: { inert?: boolean; "aria-hidden"?: boolean };
}

export function useMenuMotion(open: boolean): MenuMotion {
  const [mounted, setMounted] = useState(open);

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), MENU_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  // Read `open` itself, not only the trailing state, so the menu shows on the render its trigger flips and goes inert
  // on the render it closes.
  const closing = !open && mounted;
  return {
    shown: open || mounted,
    closing,
    className: closing ? "animate-pop-out pointer-events-none" : "animate-pop-in",
    exitProps: closing ? { inert: true, "aria-hidden": true } : {},
  };
}

export function useHeldMenuMotion<T>(value: T | null): MenuMotion & { value: T | null } {
  const motion = useMenuMotion(value != null);
  const held = useRef<T | null>(value);
  if (value != null) held.current = value;
  return { ...motion, value: value ?? held.current };
}
