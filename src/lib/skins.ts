// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.

export const SKIN_IDS = ["centipede", "midnight", "atelier", "foundry", "lagoon"] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "centipede", name: "Clinical", tagline: "Sterile surfaces. Questionable organism." },
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
];

export const DEFAULT_SKIN: SkinId = "centipede";

const KEY = "agent-centipede-skin-v1";

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isSkinId(value: string | null | undefined): value is SkinId {
  return value !== null && value !== undefined && new Set<string>(SKIN_IDS).has(value);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readSkin(): SkinId {
  try {
    const stored = getStore()?.getItem(KEY);
    return isSkinId(stored) ? stored : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/**
 * Point the document at a skin and remember it. Called once before the first
 * paint (main.tsx) and again on every change from the picker — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 */
export function applySkin(id: SkinId): void {
  document.documentElement.dataset.skin = id;
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue("--color-app").trim();
  const foreground = styles.getPropertyValue("--color-ink").trim();
  window.ogb?.setTitleBarColors?.({ background, foreground });
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
}
