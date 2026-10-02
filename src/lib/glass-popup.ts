import type { CSSProperties } from "react";
import { initialDesktopCapabilities } from "@/lib/desktop";

// Where the centred glass pop-ups (Settings, Apps, Triggers) may sit. On macOS
// the traffic lights are inset into the window's top-left corner, and on
// Windows the renderer draws caption buttons across the top-right corner: a
// pop-up that reaches either corner covers buttons people need. The frame
// (`.glass-popup-frame` in styles.css) pads the window by this top inset and
// 24px on the other sides; the pop-up (`.glass-popup`) fills at most that.

/** Clears the title-bar zone where the window draws its own buttons. */
export const GLASS_POPUP_CHROME_TOP = 56;
/** The side and bottom gutter, and the top one where nothing is drawn. */
export const GLASS_POPUP_GUTTER = 24;

/** The window chrome is a pure function of the platform (see
 * electron/capabilities.cjs), so it is known on the first frame without
 * waiting for the capabilities round trip. */
export function glassPopupTopInset(windowChrome = initialDesktopCapabilities().windowChrome): number {
  return windowChrome === "mac-inset" || windowChrome === "win-caption" ? GLASS_POPUP_CHROME_TOP : GLASS_POPUP_GUTTER;
}

/** The inline style for a `.glass-popup-frame`. */
export function glassPopupFrameStyle(): CSSProperties {
  // SAFETY: React passes custom properties through; CSSProperties just does not list them.
  return { "--glass-popup-top": `${glassPopupTopInset()}px` } as CSSProperties;
}
