// The interface font is chosen independently of the skin. Like skins, it is
// pure CSS: each non-default font is one `:root[data-font=…]` block in
// styles.css that overrides `--font-sans`; this module only decides which one
// is active and remembers it. "skin" means "whatever the active skin sets".

export const FONT_IDS = ["skin", "system", "inter", "poppins", "serif"] as const;
export type FontId = (typeof FONT_IDS)[number];

export const DEFAULT_FONT: FontId = "skin";

const KEY = "omb-font";

function isFontId(value: unknown): value is FontId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return FONT_IDS.includes(value as FontId);
}

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readFont(): FontId {
  try {
    const stored = getStore()?.getItem(KEY);
    return isFontId(stored) ? stored : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

/**
 * Stamp the font on the document and remember it. Called once before the
 * first paint (main.tsx) and again on every change from Settings. The default
 * removes the attribute so the skin's own `--font-sans` applies untouched.
 */
export function applyFont(id: FontId): void {
  if (id === DEFAULT_FONT) delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = id;
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the font still applies for this session */
  }
}
