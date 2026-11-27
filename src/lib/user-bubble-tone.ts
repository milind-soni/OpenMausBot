// Fills the person's bubble with a gradient of the bot's hue whose text clears WCAG AA at both ends.

import type { CSSProperties } from "react";
import { contrastRatio, fromOklch, mixSrgb, toOklch } from "./color-contrast";
import { MAUS_COLORS, type MausColor } from "./mascot";

const WHITE = "#ffffff";
const INK = "#101410";
/** Body text. 15px is normal text, so the bar is 4.5:1, not the large-text 3:1. */
export const BUBBLE_TEXT_MIN = 4.5;
/** A border or focus ring: WCAG 1.4.11. */
const UI_MIN = 3;
const LIGHT_END_MIN = 4.6;

export const MENTION_CHIP_MIX = 0.22;
export const SELECTION_BLACK_MIX = 0.35;
export const SELECTION_WHITE_MIX = 0.55;

const YELLOW_HUES = { from: 65, to: 115 };

export type UserBubbleTone = {
  background: string;
  deep: string;
  gradient: string;
  ink: string;
  secondary: string;
  tertiary: string;
  panel: string;
  inset: string;
  raised: string;
  raisedHover: string;
  control: string;
  hairline: string;
  accent: string;
  accentText: string;
  accentInk: string;
  focus: string;
  danger: string;
  dangerInk: string;
  success: string;
  successInk: string;
  selection: string;
  selectionInk: string;
};

function reach(target: string, hue: string, on: string, min: number): string {
  if (contrastRatio(hue, on) >= min) return hue;
  let lo = 0;
  let hi = 1;
  let best = target;
  for (let step = 0; step < 22; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = mixSrgb(target, hue, mid);
    if (contrastRatio(candidate, on) >= min) {
      best = candidate;
      hi = mid;
    } else lo = mid;
  }
  return contrastRatio(best, on) >= min ? best : target;
}

const lightEnough = (hue: string, on: string, min: number) => reach(WHITE, hue, on, min);
const darkEnough = (hue: string, on: string, min: number) => reach(INK, hue, on, min);

function quiet(ink: string, background: string, min: number): string {
  let lo = 0;
  let hi = 1;
  let best = ink;
  for (let step = 0; step < 22; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = mixSrgb(ink, background, mid);
    if (contrastRatio(candidate, background) >= min) {
      best = candidate;
      hi = mid;
    } else lo = mid;
  }
  return contrastRatio(best, background) >= min ? best : ink;
}

function darkInkOn(fill: string): string {
  return contrastRatio(INK, fill) >= BUBBLE_TEXT_MIN ? INK : WHITE;
}

function brightestCarrying(ink: string, c: number, h: number): string {
  let lo = 0.2;
  let hi = 0.95;
  let best = fromOklch({ l: lo, c, h });
  for (let step = 0; step < 24; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = fromOklch({ l: mid, c, h });
    if (contrastRatio(candidate, ink) >= LIGHT_END_MIN) {
      best = candidate;
      lo = mid;
    } else hi = mid;
  }
  return best;
}

function gradientOf(light: string, deep: string): string {
  return `linear-gradient(to bottom left, ${light}, ${deep})`;
}

function whiteInkTone(palette: string): UserBubbleTone {
  const { c, h } = toOklch(palette);
  const turn = h < 90 ? -8 : h >= 270 ? -12 : 12;
  const background = contrastRatio(WHITE, palette) >= BUBBLE_TEXT_MIN ? palette : brightestCarrying(WHITE, c * 1.05, h - turn / 2);
  const deep = fromOklch({ l: toOklch(background).l - 0.09, c: c * (h < 90 ? 1.1 : 1.25), h: h + turn });
  const secondary = quiet(WHITE, background, Math.min(6.2, Math.max(BUBBLE_TEXT_MIN, contrastRatio(WHITE, background) - 0.6)));
  let tertiary = quiet(WHITE, background, BUBBLE_TEXT_MIN);
  if (contrastRatio(tertiary, background) > contrastRatio(secondary, background)) tertiary = secondary;
  let inset = mixSrgb("#000000", background, 0.2);
  if (contrastRatio(WHITE, inset) < BUBBLE_TEXT_MIN) inset = background;
  if (contrastRatio(secondary, inset) < BUBBLE_TEXT_MIN) inset = background;
  const panel = mixSrgb(inset, background, 0.45);
  let raised = mixSrgb(WHITE, background, 0.1);
  if (contrastRatio(WHITE, raised) < BUBBLE_TEXT_MIN) raised = background;
  let raisedHover = mixSrgb(WHITE, background, 0.16);
  if (contrastRatio(WHITE, raisedHover) < BUBBLE_TEXT_MIN) raisedHover = raised;
  const hairline = lightEnough(mixSrgb(WHITE, background, 0.45), background, UI_MIN);
  let accent = lightEnough(palette, background, BUBBLE_TEXT_MIN);
  if (contrastRatio(accent, raised) < BUBBLE_TEXT_MIN) accent = lightEnough(accent, raised, BUBBLE_TEXT_MIN);
  if (contrastRatio(INK, accent) < BUBBLE_TEXT_MIN) accent = lightEnough(accent, INK, BUBBLE_TEXT_MIN);
  const danger = lightEnough("#ff6d80", background, BUBBLE_TEXT_MIN);
  const success = lightEnough("#7ddead", background, BUBBLE_TEXT_MIN);
  return {
    background,
    deep,
    gradient: gradientOf(background, deep),
    ink: WHITE,
    secondary,
    tertiary,
    panel,
    inset,
    raised,
    raisedHover,
    control: raised,
    hairline,
    accent,
    accentText: accent,
    accentInk: darkInkOn(accent),
    focus: accent,
    danger,
    dangerInk: darkInkOn(danger),
    success,
    successInk: darkInkOn(success),
    selection: selectionBackground(background),
    selectionInk: WHITE,
  };
}

function darkInkTone(palette: string): UserBubbleTone {
  const { c, h } = toOklch(palette);
  const background = fromOklch({ l: 0.8, c: c * 1.1, h: h + 2 });
  const deep = fromOklch({ l: 0.72, c: c * 1.25, h: h - 16 });
  const secondary = quiet(INK, deep, Math.min(6.2, Math.max(BUBBLE_TEXT_MIN, contrastRatio(INK, deep) - 0.6)));
  let tertiary = quiet(INK, deep, BUBBLE_TEXT_MIN);
  if (contrastRatio(tertiary, deep) > contrastRatio(secondary, deep)) tertiary = secondary;
  const inset = mixSrgb(WHITE, deep, 0.35);
  const raised = mixSrgb(WHITE, deep, 0.18);
  const accent = darkEnough(palette, deep, BUBBLE_TEXT_MIN);
  const danger = darkEnough("#c02b3a", deep, BUBBLE_TEXT_MIN);
  const success = darkEnough("#1f7a4d", deep, BUBBLE_TEXT_MIN);
  return {
    background,
    deep,
    gradient: gradientOf(background, deep),
    ink: INK,
    secondary,
    tertiary,
    panel: mixSrgb(inset, deep, 0.45),
    inset,
    raised,
    raisedHover: mixSrgb(WHITE, deep, 0.28),
    control: raised,
    hairline: darkEnough(mixSrgb(INK, deep, 0.35), deep, UI_MIN),
    accent,
    accentText: accent,
    accentInk: darkInkOn(accent),
    focus: accent,
    danger,
    dangerInk: darkInkOn(danger),
    success,
    successInk: darkInkOn(success),
    selection: mixSrgb(WHITE, background, SELECTION_WHITE_MIX),
    selectionInk: INK,
  };
}

export function userBubbleTone(color: MausColor): UserBubbleTone {
  const palette = MAUS_COLORS[color];
  const { h } = toOklch(palette);
  return h >= YELLOW_HUES.from && h <= YELLOW_HUES.to ? darkInkTone(palette) : whiteInkTone(palette);
}

export function mentionChipBackground(mention: string, inset: string): string {
  return mixSrgb(mention, inset, MENTION_CHIP_MIX);
}

export function selectionBackground(background: string): string {
  return mixSrgb("#000000", background, SELECTION_BLACK_MIX);
}

export function quoteSurface(inset: string, background: string): string {
  return mixSrgb(inset, background, 0.7);
}

/** `flat`: Simple mode's one even fill, the tone's background with no gradient over it. */
export function userBubbleStyle(color: MausColor, { flat = false }: { flat?: boolean } = {}): CSSProperties {
  const tone = userBubbleTone(color);
  return {
    backgroundColor: tone.background,
    backgroundImage: flat ? "none" : tone.gradient,
    "--color-bubble-user": tone.background,
    "--color-bubble-user-ink": tone.ink,
    "--color-ink": tone.ink,
    "--color-ink-secondary": tone.secondary,
    "--color-ink-tertiary": tone.tertiary,
    "--color-panel": tone.panel,
    "--color-inset": tone.inset,
    "--color-raised": tone.raised,
    "--color-raised-hover": tone.raisedHover,
    "--color-control": tone.control,
    "--color-hairline": tone.hairline,
    "--color-accent": tone.accent,
    "--color-accent-text": tone.accentText,
    "--color-accent-ink": tone.accentInk,
    "--color-focus": tone.focus,
    "--color-danger": tone.danger,
    "--color-danger-ink": tone.dangerInk,
    "--color-success": tone.success,
    "--color-success-ink": tone.successInk,
    "--bubble-selection": tone.selection,
    "--bubble-selection-ink": tone.selectionInk,
  } as CSSProperties;
}
