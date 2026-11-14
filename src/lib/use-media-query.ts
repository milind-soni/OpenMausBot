import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
      if (!media) return () => {};
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

export const TWO_SIDE_PANELS_FIT = "(min-width: 1536px)";

export const SIDEBAR_AND_PANEL_FIT = "(min-width: 1280px)";

/** Tailwind's md breakpoint. */
export const SIDEBAR_INLINE = "(min-width: 768px)";

/** Below Tailwind's md breakpoint: the phone layout, where the sidebar is a full-screen bot list. */
export const PHONE_LAYOUT = "(max-width: 767.98px)";
