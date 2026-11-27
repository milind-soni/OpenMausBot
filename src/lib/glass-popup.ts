import type { CSSProperties } from "react";
import { initialDesktopCapabilities } from "@/lib/desktop";

// macOS traffic lights and Windows caption buttons sit in the top corners; pop-ups must not cover them.
export const GLASS_POPUP_CHROME_TOP = 56;
export const GLASS_POPUP_GUTTER = 24;

export function glassPopupTopInset(windowChrome = initialDesktopCapabilities().windowChrome): number {
  return windowChrome === "mac-inset" || windowChrome === "win-caption" ? GLASS_POPUP_CHROME_TOP : GLASS_POPUP_GUTTER;
}

export function glassPopupFrameStyle(): CSSProperties {
  // SAFETY: React passes custom properties through; CSSProperties just does not list them.
  return { "--glass-popup-top": `${glassPopupTopInset()}px` } as CSSProperties;
}
