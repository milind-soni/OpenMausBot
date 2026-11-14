// A person's own look for the app: colours derived onto the app's colour tokens, a stylesheet applied after the app's
// own, and image or font files the stylesheet may use. Bots write themes through app_settings; Settings → Appearance
// edits, imports and exports them.
import { z } from "zod";

import { SKIN_IDS } from "./app-settings.ts";

/** Where a theme's files are served, same origin, behind the server's sign-in: `<prefix><themeId>/<file>`. */
export const THEME_ASSET_PREFIX = "/api/theme-assets/";
/** Opening the app with this in its address starts it without the custom theme. */
export const SAFE_LOOK_PARAM = "safe-look";

export const THEME_LIMITS = {
  cssChars: 100_000,
  assetBytes: 10 * 1024 * 1024,
  themeBytes: 40 * 1024 * 1024,
  assetsPerTheme: 40,
  themesPerPerson: 50,
} as const;

export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const THEME_ASSET_NAME = /^[a-z0-9][a-z0-9_-]{0,79}\.(png|jpe?g|webp|gif|avif|svg|woff2?|ttf|otf)$/;
const ASSET_URL = /^\/api\/theme-assets\/[a-z0-9][a-z0-9-]{0,47}\/[a-z0-9][a-z0-9_-]{0,79}\.[a-z0-9]{2,5}$/;

export const THEME_ASSET_TYPES: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif",
  svg: "image/svg+xml", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

/** The app's colour tokens a theme may set, as `--color-<role>`. */
export const THEME_COLOR_ROLES = [
  "app", "panel", "frame", "raised", "raised-hover", "card", "inset", "control", "composer", "composer-ring",
  "menu", "menu-hover", "menu-active", "hairline", "edge", "scrollbar",
  "ink", "ink-secondary", "ink-tertiary", "accent", "accent-border", "accent-text", "accent-ink", "focus",
  "bubble-user", "bubble-user-ink", "success", "success-ink", "danger", "danger-ink", "warning",
] as const;
export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];

export const THEME_ROLE_HELP: Readonly<Record<ThemeColorRole, string>> = {
  app: "the window's ground behind the chat", panel: "the sidebar", frame: "the top bar and the rail around the app",
  raised: "content surfaces", "raised-hover": "a hovered row or button", card: "cards and the bot's bubble", inset: "sunken fields",
  control: "a control on a card", composer: "the message box", "composer-ring": "the message box's outline", menu: "menus and popovers",
  "menu-hover": "a hovered menu row", "menu-active": "a chosen menu row", hairline: "borders", edge: "the line where two panes meet",
  scrollbar: "scrollbar thumbs", ink: "main text", "ink-secondary": "quieter text", "ink-tertiary": "the quietest text: hints and times",
  accent: "buttons and highlights", "accent-border": "the accent's edge", "accent-text": "links and accent text", "accent-ink": "text on the accent",
  focus: "the keyboard focus ring", "bubble-user": "your own messages", "bubble-user-ink": "text in your own messages",
  success: "done and OK", "success-ink": "text on success", danger: "errors and delete", "danger-ink": "text on danger", warning: "warnings",
};

const hex = z.string().trim().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "a hex colour such as #1a2b3c");
/** Security: a colour lands in a custom property the app's own rules read, so it may never name a file. */
const color = z.string().trim().min(1).max(120)
  .regex(/^[#a-z0-9(),.%\s/+-]+$/i, "a CSS colour such as #1a2b3c, rgb(…) or color-mix(…)")
  .refine((value) => !/url|image|src|attr/i.test(value), "a colour, not a file");
const colors = z.partialRecord(z.enum(THEME_COLOR_ROLES), color);
const variant = z.object({ canvas: hex.optional(), accent: hex.optional(), colors: colors.optional() }).strict();

/** A theme as it is saved, exported and sent by a bot. */
export const themeFileSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** The built-in skin underneath: what any colour the theme leaves out comes from. Absent: the one matching the canvas. */
  skin: z.enum([...SKIN_IDS, "system"]).optional(),
  /** The base background; the app derives its surfaces, lines and text from it. */
  canvas: hex.optional(),
  accent: hex.optional(),
  /** Single colour roles, over what canvas and accent derive. */
  colors: colors.optional(),
  /** The same, used only while the app is light or dark. */
  light: variant.optional(),
  dark: variant.optional(),
  /** A font-family list: bundled fonts, fonts installed on the computer, or one the CSS loads with @font-face. */
  font: z.string().trim().max(300).regex(/^[\w\s"',.-]*$/, "a font-family list such as \"Inter Variable\", serif").optional(),
  css: z.string().max(THEME_LIMITS.cssChars).optional(),
}).strict();
export type ThemeFile = z.infer<typeof themeFileSchema>;

export interface ThemeSummary {
  id: string;
  name: string;
  hasCss: boolean;
  assets: string[];
}
/** GET /api/themes: this person's saved themes and the one their windows wear. */
export interface ThemeList {
  active: string | null;
  themes: ThemeSummary[];
}
/** GET /api/themes/active. */
export interface ActiveTheme {
  id: string | null;
  theme: ThemeFile | null;
}
export const THEME_EXPORT_VERSION = 1;
/** One file: the theme with its files inlined as data: addresses. */
export const themeExportSchema = z.object({
  mausbotTheme: z.literal(THEME_EXPORT_VERSION),
  id: z.string().regex(THEME_ID).optional(),
  theme: themeFileSchema,
  assets: z.record(z.string().regex(THEME_ASSET_NAME), z.string().max(Math.ceil(THEME_LIMITS.assetBytes * 1.4)).regex(/^data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+$/)).optional(),
}).strict();
export type ThemeExport = z.infer<typeof themeExportSchema>;

export const themeAssetUrl = (themeId: string, name: string) => `${THEME_ASSET_PREFIX}${themeId}/${name}`;
export const themeAssetType = (name: string): string | undefined => THEME_ASSET_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];

/** A url() target a theme may load: an inline data: address, a fragment, or one of the theme files on this server. */
export function themeUrlAllowed(target: string): boolean {
  return /^data:/i.test(target) || target.startsWith("#") || (ASSET_URL.test(target) && !target.includes(".."));
}

/** Every url() argument in `text`, or null when one cannot be read cleanly. */
function urlTargets(text: string): string[] | null {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (let at = lower.indexOf("url("); at !== -1; at = lower.indexOf("url(", at + 4)) {
    let index = at + 4;
    while (/\s/.test(text[index] ?? "")) index++;
    const quote = text[index];
    let target: string;
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, index + 1);
      if (close === -1) return null;
      target = text.slice(index + 1, close);
      index = close + 1;
      while (/\s/.test(text[index] ?? "")) index++;
      if (text[index] !== ")") return null;
    } else {
      const close = text.indexOf(")", index);
      if (close === -1) return null;
      target = text.slice(index, close).trim();
      if (/[\s"'(]/.test(target)) return null;
    }
    found.push(target.trim());
  }
  return found;
}

const LOADS_BY_NAME = /image-set\(|\bimage\(|\bsrc\(/i;

/**
 * Security: whether one parsed declaration value could load a file from anywhere but this server's theme files. The
 * window drops such declarations. A value that still holds a backslash is refused whole: an escape can spell `url` or
 * `var` where a check of the text would not see it.
 */
export function themeValueLoads(value: string): boolean {
  if (value.includes("\\") || LOADS_BY_NAME.test(value)) return true;
  const targets = urlTargets(value);
  return targets === null || targets.some((target) => !themeUrlAllowed(target));
}

/** The text with comments and quoted strings blanked, so a check of the code ignores what they say. */
function codeOnly(css: string): string {
  let out = "";
  for (let index = 0; index < css.length; index++) {
    const char = css[index]!;
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 1;
      out += " ";
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < css.length && css[end] !== char && css[end] !== "\n") end += css[end] === "\\" ? 2 : 1;
      out += `${char}${" ".repeat(Math.max(0, end - index - 1))}${char}`;
      index = end;
    } else out += char;
  }
  return out;
}

/**
 * The server's early answer on a theme's CSS, in words a bot or person can act on; null when nothing in the text loads a
 * file. Escapes can hide from a text check, so the window's check of the parsed rules is the guard.
 */
export function themeCssProblem(css: string): string | null {
  const code = codeOnly(css);
  if (/@import/i.test(code)) return "@import is not allowed: themes cannot load other stylesheets.";
  if (code.includes("\\")) return "Backslash escapes are only allowed inside quoted strings.";
  if (LOADS_BY_NAME.test(code)) return "image-set(), image() and src() are not allowed: use url() with a theme file or a data: address.";
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const targets = urlTargets(withoutComments);
  if (targets === null) return "A url() could not be read. Write url(\"/api/theme-assets/<theme>/<file>\").";
  const remote = targets.find((target) => !themeUrlAllowed(target));
  if (remote !== undefined) return `url(${remote.slice(0, 80)}) is not allowed: themes load only their own files (${THEME_ASSET_PREFIX}<theme>/<file>), data: addresses or #ids, never the internet.`;
  return null;
}

/** The theme's url() targets under this server's theme files, for re-homing them on import or duplicate. */
export function rehomeThemeCss(css: string, fromId: string, toId: string): string {
  return css.split(`${THEME_ASSET_PREFIX}${fromId}/`).join(`${THEME_ASSET_PREFIX}${toId}/`);
}

/**
 * Selectors a theme can rely on across releases. The app's other class names are utilities that change; tests fail when
 * one of these leaves the app's source.
 */
export const THEME_HOOKS = [
  { selector: '[data-look="app"]', what: "the whole window, behind everything" },
  { selector: '[data-look="rail"]', what: "the rail of places down the side (desktop app)" },
  { selector: '[data-look="sidebar"]', what: "the sidebar" },
  { selector: '[data-look="sidebar-bot"]', what: "a bot's row in the sidebar" },
  { selector: '[data-look="sidebar-thread"]', what: "a conversation's row in the sidebar" },
  { selector: '[data-look="avatar"]', what: "a bot's picture" },
  { selector: '[data-look="chat-header"]', what: "the bar at the top of a chat" },
  { selector: '[data-look="chat"]', what: "the chat area, behind the messages" },
  { selector: '[data-look="message-user"]', what: "a row with your own message" },
  { selector: '[data-look="message-bot"]', what: "a row with a bot's message" },
  { selector: '[data-look="user-bubble"]', what: "your own message's bubble" },
  { selector: '[data-look="bot-bubble"]', what: "a bot's message bubble" },
  { selector: '[data-look="bot-text"]', what: "a bot's message text" },
  { selector: '[data-look="code-block"]', what: "a code block" },
  { selector: '[data-look="composer"]', what: "the message box" },
  { selector: '[data-look="ask-card"]', what: "a question card a bot asks you" },
  { selector: '[data-look="approval-card"]', what: "a card asking you to allow something" },
  { selector: '[data-look="inbox"]', what: "the inbox panel" },
  { selector: '[data-look="settings"]', what: "the Settings page" },
  { selector: '[data-look="dialog"]', what: "a dialog box" },
  { selector: '[data-look="menu"]', what: "a menu" },
  { selector: '[data-look="popover"]', what: "a popover" },
  { selector: '[data-look="tooltip"]', what: "a tooltip" },
  { selector: '[data-look="switch"]', what: "an on/off switch" },
  { selector: '[data-look="select"]', what: "a drop-down list" },
  { selector: "button", what: "every button" },
  { selector: "input, textarea", what: "text fields" },
  { selector: '[role="dialog"]', what: "every dialog, including ones without a hook" },
  { selector: '[role="menu"]', what: "every menu" },
  { selector: "::-webkit-scrollbar, ::-webkit-scrollbar-thumb", what: "scrollbars and their thumbs" },
] as const;

const SHORTCUT = "Cmd+Option+Shift+R on a Mac, Ctrl+Alt+Shift+R elsewhere";

/** What a bot needs to restyle the app; app_settings `theme` returns it. */
export function themeGuide(): string {
  return [
    "A theme restyles MausBot's desktop app and web app for the person who asked, in every window they have open. Phones keep their own look.",
    "",
    "Colours first. `canvas` (hex) is the base background and `accent` (hex) the highlight; the app derives its surfaces, lines and text from them.",
    "`skin` picks the built-in skin underneath, so anything the theme leaves out comes from it. `colors` sets single roles; `light` and `dark` hold canvas, accent and colors used only in that mode.",
    `Roles: ${THEME_COLOR_ROLES.map((role) => `${role} (${THEME_ROLE_HELP[role]})`).join("; ")}.`,
    "`font` is a font-family list. Bundled: \"Geist Variable\", \"Inter Variable\", \"Geist Mono Variable\". A font installed on the computer works by name, and a font file can be a theme file loaded with @font-face.",
    "",
    `CSS: \`css\` (up to ${THEME_LIMITS.cssChars.toLocaleString("en")} characters) applies after the app's own styles. Anything goes: borders, roundness, spacing, bubble shapes, backgrounds, @keyframes animations, hover effects.`,
    "The app's own rules can be more specific; add !important when a rule has no effect. Respect @media (prefers-reduced-motion: reduce) for big animations.",
    "Never the internet: @import, image-set(), image(), src() and url() to any other address are removed, and so is any value with a backslash escape outside a string.",
    `url() may name a theme file (${THEME_ASSET_PREFIX}<theme id>/<file>), a data: address or an #id.`,
    "Theme files: add_theme_asset copies an image (png, jpg, webp, gif, avif, svg; animated is fine) or a font (woff2, woff, ttf, otf) from your workspace or this conversation's attachments into a theme, up to 10 MB each. It answers with the url() to use.",
    "",
    "Stable selectors (other class names change between releases, so never rely on them):",
    ...THEME_HOOKS.map((hook) => `- ${hook.selector}: ${hook.what}`),
    "",
    "Calls: theme (optional id: also return that saved theme). set_theme with id and theme (the theme as JSON) saves and wears it; with only id it wears a saved theme, a built-in skin, or none. add_theme_asset with id and path.",
    "",
    "You cannot see the result. Make one small change at a time, then ask the person how it looks.",
    `Undo: set_theme with a built-in skin id, or "none" to drop the custom theme; the card in the conversation also has Undo. If a theme hides what the person needs, tell them: ${SHORTCUT} resets to the default look, and opening the app with ?${SAFE_LOOK_PARAM} in its address starts it without the theme.`,
  ].join("\n");
}
