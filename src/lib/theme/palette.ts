import type { ThemeColorRole } from "../../../shared/theme";

export type Mode = "light" | "dark";
type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

export function parseHex(hex: string): Rgb {
  const digits = hex.trim().replace(/^#/, "");
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
  const value = Number.parseInt(full.slice(0, 6), 16);
  return Number.isFinite(value) ? [(value >> 16) & 255, (value >> 8) & 255, value & 255] : BLACK;
}

const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
const toHex = ([r, g, b]: Rgb, alpha?: number) => `#${channel(r)}${channel(g)}${channel(b)}${alpha === undefined ? "" : channel(alpha * 255)}`;
/** `amount` of `to` mixed into `from`. */
const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [0, 1, 2].map((index) => from[index]! + (to[index]! - from[index]!) * amount) as unknown as Rgb;

function luminance([r, g, b]: Rgb): number {
  const linear = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Whether a background reads as a dark or a light one. */
export const modeOf = (hex: string): Mode => (luminance(parseHex(hex)) < 0.2 ? "dark" : "light");

/** `color` moved toward white or black, away from `on`, until it reaches `ratio` against it. */
function legible(color: Rgb, on: Rgb, ratio: number): Rgb {
  const toward = luminance(on) < 0.2 ? WHITE : BLACK;
  let next = color;
  for (let step = 1; step <= 20 && contrast(next, on) < ratio; step++) next = mix(color, toward, step / 20);
  return next;
}

const inkOn = (surface: Rgb): Rgb => (contrast(WHITE, surface) >= contrast(BLACK, surface) ? WHITE : [17, 17, 17]);

/** The surfaces, lines and text a base background implies, in the app's colour roles. */
export function canvasPalette(canvas: string, mode: Mode): Partial<Record<ThemeColorRole, string>> {
  const base = parseHex(canvas);
  const dark = mode === "dark";
  const lift = (amount: number) => mix(base, dark ? WHITE : BLACK, amount);
  const raised = dark ? lift(0.08) : mix(base, WHITE, 0.85);
  const hover = lift(dark ? 0.14 : 0.06);
  const ink = legible(mix(dark ? WHITE : BLACK, base, dark ? 0.04 : 0.1), base, 12);
  const bubble = dark ? lift(0.22) : lift(0.07);
  return {
    app: toHex(base),
    panel: toHex(dark ? mix(base, BLACK, 0.25) : mix(base, WHITE, 0.45)),
    frame: toHex(dark ? mix(base, BLACK, 0.25) : mix(base, WHITE, 0.45)),
    raised: toHex(raised),
    "raised-hover": toHex(hover),
    card: toHex(dark ? lift(0.07) : raised),
    inset: toHex(dark ? lift(0.04) : base),
    control: toHex(lift(dark ? 0.12 : 0.07)),
    composer: toHex(dark ? lift(0.07) : raised),
    "composer-ring": toHex(lift(dark ? 0.14 : 0.12)),
    menu: toHex(raised),
    "menu-hover": toHex(ink, 0.06),
    "menu-active": toHex(ink, 0.09),
    hairline: toHex(lift(0.2)),
    edge: toHex(ink, 0.08),
    scrollbar: toHex(lift(dark ? 0.25 : 0.22)),
    ink: toHex(ink),
    "ink-secondary": toHex(legible(mix(ink, base, dark ? 0.3 : 0.4), hover, 4.5)),
    "ink-tertiary": toHex(legible(mix(ink, base, dark ? 0.42 : 0.5), hover, 4.5)),
    "bubble-user": toHex(bubble),
    "bubble-user-ink": toHex(dark ? inkOn(bubble) : ink),
  };
}

/** The accent's fill, edge, text and focus ring, readable on `ground`. */
export function accentPalette(accent: string, mode: Mode, ground: string): Partial<Record<ThemeColorRole, string>> {
  const fill = parseHex(accent);
  const text = legible(fill, parseHex(ground), 4.5);
  return {
    accent: toHex(fill),
    "accent-ink": toHex(inkOn(fill)),
    "accent-border": toHex(mode === "dark" ? mix(fill, WHITE, 0.2) : mix(fill, BLACK, 0.1)),
    "accent-text": toHex(text),
    focus: toHex(text),
  };
}
