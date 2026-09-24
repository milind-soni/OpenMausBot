// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.

export const SKIN_IDS = [
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "graphite",
  "linen",
  "dusk",
  "daylight",
  "chatgpt",
  "custom",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
  { id: "graphite", name: "Graphite", tagline: "Quiet charcoal and softened steel blue." },
  { id: "linen", name: "Linen", tagline: "Clean daylight with a restrained navy accent." },
  { id: "dusk", name: "Dusk", tagline: "Muted plum after dark, calm and low-key." },
  { id: "daylight", name: "Daylight", tagline: "Midnight in reverse. Near-white, ink-black bubbles." },
  { id: "chatgpt", name: "ChatGPT", tagline: "White conversation, pale blue sidebar, black user messages." },
  { id: "custom", name: "Custom", tagline: "Your own colors for every part of the app." },
];

export const DEFAULT_SKIN: SkinId = "midnight";

const KEY = "omb-skin";
const CUSTOM_KEY = "omb-custom-theme";

/** Every editable color role used by the skins. The editor and application use
 * one allowlist, so imported storage cannot inject CSS or omit a control. */
export const COLOR_ROLES = [
  "app", "panel", "raised", "raised-hover", "composer", "composer-ring",
  "card", "menu", "inset", "control", "hairline", "ink", "ink-secondary",
  "accent", "accent-border", "accent-text", "accent-ink", "focus",
  "bubble-user", "bubble-user-ink", "success", "success-ink",
  "danger", "danger-ink", "warning", "scrollbar", "maus-line",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
export type CustomTheme = Record<ColorRole, string> & {
  layout?: "standard" | "chatgpt";
  fontSans?: string;
  radiusLg?: string;
  radiusXl?: string;
  codeColorScheme?: "light" | "dark";
};

const colorValue = (value: unknown): value is string =>
  typeof value === "string" && (value === "transparent" || /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value));

export function readCustomTheme(): CustomTheme | null {
  try {
    const parsed: unknown = JSON.parse(getStore()?.getItem(CUSTOM_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const values = parsed as Record<string, unknown>;
    if (!COLOR_ROLES.every((role) => colorValue(values[role]))) return null;
    return {
      ...Object.fromEntries(COLOR_ROLES.map((role) => [role, values[role]])),
      layout: values.layout === "chatgpt" ? "chatgpt" : "standard",
      fontSans: typeof values.fontSans === "string" && values.fontSans.length < 300 && !/url\s*\(/i.test(values.fontSans) ? values.fontSans : undefined,
      radiusLg: typeof values.radiusLg === "string" && /^\d+(\.\d+)?(px|rem)$/.test(values.radiusLg) ? values.radiusLg : undefined,
      radiusXl: typeof values.radiusXl === "string" && /^\d+(\.\d+)?(px|rem)$/.test(values.radiusXl) ? values.radiusXl : undefined,
      codeColorScheme: values.codeColorScheme === "dark" || values.codeColorScheme === "light" ? values.codeColorScheme : undefined,
    } as CustomTheme;
  } catch { return null; }
}

/** Capture all roles from a real skin, including values inherited from the
 * base stylesheet, so any preset can be recreated exactly in Custom. */
export function colorsFromSkin(id: Exclude<SkinId, "custom">): CustomTheme {
  // Server rendering and static settings tests have no DOM. The editor is
  // interactive only in a browser; this placeholder is never saved there.
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return { ...Object.fromEntries(COLOR_ROLES.map((role) => [role, "#000000"])), layout: id === "chatgpt" ? "chatgpt" : "standard" } as CustomTheme;
  }
  const probe = document.createElement("div");
  probe.dataset.skin = id;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  try {
    const computed = getComputedStyle(probe);
    return {
      ...Object.fromEntries(COLOR_ROLES.map((role) =>
        [role, computed.getPropertyValue(`--color-${role}`).trim()]
      )),
      layout: id === "chatgpt" ? "chatgpt" : "standard",
      fontSans: computed.getPropertyValue("--font-sans").trim(),
      radiusLg: computed.getPropertyValue("--radius-lg").trim(),
      radiusXl: computed.getPropertyValue("--radius-xl").trim(),
      codeColorScheme: computed.getPropertyValue("--code-color-scheme").trim() === "dark" ? "dark" : "light",
    } as CustomTheme;
  } finally { probe.remove(); }
}

export function saveCustomTheme(theme: CustomTheme): void {
  if (!COLOR_ROLES.every((role) => colorValue(theme[role]))) throw new Error("Invalid theme color");
  try { getStore()?.setItem(CUSTOM_KEY, JSON.stringify(theme)); } catch { /* session-only storage */ }
  applySkin("custom", theme);
}

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isSkinId(value: unknown): value is SkinId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return SKIN_IDS.includes(value as SkinId);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    // A bare feature test, not a narrowing of parsed input: in a renderer
    // without storage the identifier is simply not defined.
    return typeof localStorage === "undefined" ? undefined : localStorage;
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
export function applySkin(id: SkinId, providedCustom?: CustomTheme): void {
  for (const role of COLOR_ROLES) document.documentElement.style.removeProperty(`--color-${role}`);
  document.documentElement.style.removeProperty("--code-color-scheme");
  document.documentElement.style.removeProperty("--font-sans");
  document.documentElement.style.removeProperty("--radius-lg");
  document.documentElement.style.removeProperty("--radius-xl");
  document.documentElement.dataset.skin = id;
  const custom = id === "custom" ? providedCustom ?? readCustomTheme() : null;
  document.documentElement.dataset.chatLayout = id === "chatgpt" || custom?.layout === "chatgpt" ? "chatgpt" : "standard";
  const palette = id === "custom" ? custom : id === "daylight" || id === "chatgpt" ? colorsFromSkin(id) : null;
  const brightness = (value: string) => value.startsWith("#") ? Number.parseInt(value.slice(1, 3), 16) * 0.2126 + Number.parseInt(value.slice(3, 5), 16) * 0.7152 + Number.parseInt(value.slice(5, 7), 16) * 0.0722 : 0;
  document.documentElement.dataset.invertedUserBubble = palette && brightness(palette.ink) < 128 && brightness(palette["bubble-user"]) < 128 && brightness(palette["bubble-user-ink"]) > 128 ? "true" : "false";
  if (id === "custom") {
    if (custom) for (const role of COLOR_ROLES) {
      document.documentElement.style.setProperty(`--color-${role}`, custom[role]);
    }
    if (custom) {
      document.documentElement.style.setProperty("--code-color-scheme", custom.codeColorScheme ?? (brightness(custom.app) > 128 ? "light" : "dark"));
      if (custom.fontSans) document.documentElement.style.setProperty("--font-sans", custom.fontSans);
      if (custom.radiusLg) document.documentElement.style.setProperty("--radius-lg", custom.radiusLg);
      if (custom.radiusXl) document.documentElement.style.setProperty("--radius-xl", custom.radiusXl);
    }
  }
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints. Left at the default it stays
  // Midnight-black on a light skin — the "black block in the top-right
  // corner" of issue #454. Best-effort: a browser tab or an older desktop
  // build has no bridge, and the skin still applies without it.
  try {
    const appColor = id === "custom" ? (providedCustom ?? readCustomTheme())?.app : undefined;
    void window.ogb?.applySkin?.(appColor ? { id: "custom", color: appColor } : id)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}
