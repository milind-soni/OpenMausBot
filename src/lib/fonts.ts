import { FONT_IDS } from "../../shared/app-settings";

export { FONT_IDS };
export type FontId = (typeof FONT_IDS)[number];

export const DEFAULT_FONT: FontId = "skin";

export const FONT_KEY = "omb-font";

function isFontId(value: unknown): value is FontId {
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
    const stored = getStore()?.getItem(FONT_KEY);
    return isFontId(stored) ? stored : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

export function applyFont(id: FontId): void {
  if (id === DEFAULT_FONT) delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = id;
  try {
    getStore()?.setItem(FONT_KEY, id);
  } catch {
  }
}
