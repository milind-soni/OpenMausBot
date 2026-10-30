// The page a bot's browser shows its viewers: the size a setting gives it within the screen, and how a zoom lays it out.
import { fitPage } from "../chrome/flags.ts";

export const UNATTACHED_VIEWPORT = { width: 1280, height: 800 } as const;
export const VIEWPORT_LIMITS = { minWidth: 100, minHeight: 100, maxWidth: 3840, maxHeight: 2160 } as const;
/** Chrome keeps a window at least this wide (measured on 153); a narrower page needs emulation. */
export const MIN_WINDOW_WIDTH = 500;
/** Chrome's own zoom range. */
export const ZOOM_LIMITS = { min: 0.25, max: 5 } as const;

/** The viewport sizes a person can pick: fill follows the panel; a preset letterboxes in it. */
export const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;

/** The standard page's width: a filled panel never makes the page narrower, so sites keep the desktop layout the bot knows. */
export const DESKTOP_WIDTH = UNATTACHED_VIEWPORT.width;
/** A filled page is at most this many times as tall as it is wide; a panel taller than that shows bands above and below it. */
export const MAX_FILL_RATIO = 2;

/** The page that fills a panel of `panel` CSS pixels when the viewer scales it to the panel: the panel's shape, at least a desktop wide. */
export function fillPage(panel: { width: number; height: number }): { width: number; height: number } {
  const width = Math.max(Math.round(panel.width), DESKTOP_WIDTH);
  return { width, height: Math.min(Math.round(panel.height * width / panel.width), MAX_FILL_RATIO * width) };
}

export const fitsScreen = (size: { width: number; height: number }, limit: { width: number; height: number } | null) =>
  !limit || (size.width <= limit.width && size.height <= limit.height);

/** A viewer's panel size, or null when it is out of range (a collapsed panel, say) and the page keeps its size. */
export function requestedSize(width: unknown, height: unknown): { width: number; height: number } | null {
  const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const w = Math.min(Math.round(finite(width)), VIEWPORT_LIMITS.maxWidth);
  const h = Math.min(Math.round(finite(height)), VIEWPORT_LIMITS.maxHeight);
  return w >= VIEWPORT_LIMITS.minWidth && h >= VIEWPORT_LIMITS.minHeight ? { width: w, height: h } : null;
}

export type ViewportSetting =
  | { mode: "fill" }
  | { mode: "preset"; preset: keyof typeof VIEWPORT_PRESETS; landscape?: boolean }
  | { mode: "fixed"; width: number; height: number };

/**
 * The CSS size `setting` gives the page, `requested` being the panel size of the viewer that asked last, within `limit`,
 * the largest page the screen fits: with nobody watching, the standard size fitted to the screen; a filled panel gets
 * its own shape at a desktop's width, which the viewer scales to fill it, shown smaller by a window held to its screen
 * while that keeps it as wide as the standard page, and emulated otherwise; a set size is cut to fit.
 */
export function viewportFor(setting: ViewportSetting, requested: { width: number; height: number } | null, limit: { width: number; height: number } | null = null): { width: number; height: number } {
  if (setting.mode === "fill") {
    const standard = fitPage({ ...UNATTACHED_VIEWPORT }, limit);
    if (!requested) return standard;
    const page = fillPage(requested);
    const fitted = fitPage(page, limit);
    return fitted.width >= standard.width ? fitted : page;
  }
  const size = setting.mode === "fixed" ? { width: setting.width, height: setting.height } : presetSize(setting);
  if (!limit) return size;
  return { width: size.width < MIN_WINDOW_WIDTH ? size.width : Math.min(size.width, limit.width), height: Math.min(size.height, limit.height) };
}

function presetSize(setting: Extract<ViewportSetting, { mode: "preset" }>): { width: number; height: number } {
  const preset = VIEWPORT_PRESETS[setting.preset];
  return setting.landscape ? { width: preset.height, height: preset.width } : { ...preset };
}

/** The CSS size a page of `size` lays out in at `zoom`, as Chrome zooms. */
export const zoomedLayout = (size: { width: number; height: number }, zoom: number) => ({ width: Math.max(1, Math.round(size.width / zoom)), height: Math.max(1, Math.round(size.height / zoom)) });
