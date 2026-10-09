// The person's own bubble, painted in the bot's color.
//
// Palette swatches are chosen as avatar fills, not as text backgrounds.
// Several of them (yellow, orange, cyan, teal, coral) are too light for
// white body text. This deepens the same hue until white clears WCAG AA,
// then derives the tokens children already use (links, code, mentions,
// quotes, the editor) so they stay readable on that fill. The fill is
// opaque, so the skin behind it does not change the ratios.

import type { CSSProperties } from "react";
import { contrastRatio, mixSrgb, toneForSurface } from "./color-contrast";
import { MAUS_COLORS, type MausColor } from "./mascot";

const WHITE = "#ffffff";
const INK = "#101410";
/** Body text. 15px is normal text, so the bar is 4.5:1, not the large-text 3:1. */
export const BUBBLE_TEXT_MIN = 4.5;
/** A border or focus ring. WCAG 1.4.11. */
const UI_MIN = 3;

/** How much of the mention's own color tints the chip behind white text. */
export const MENTION_CHIP_MIX = 0.22;
/** Selection darkens the fill so white text stays above the bar. */
export const SELECTION_BLACK_MIX = 0.35;

export type UserBubbleTone = {
  background: string;
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
};

/** Least white mixed into `hue` that still clears `min` against `on`. Keeps the hue when it already passes. */
function lightEnough(hue: string, on: string, min: number): string {
  if (contrastRatio(hue, on) >= min) return hue;
  let lo = 0;
  let hi = 1;
  let best = WHITE;
  for (let step = 0; step < 22; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = mixSrgb(WHITE, hue, mid);
    if (contrastRatio(candidate, on) >= min) {
      best = candidate;
      hi = mid;
    } else lo = mid;
  }
  return contrastRatio(best, on) >= min ? best : WHITE;
}

/** Quiet white-mix whose contrast against `background` is at least `min` and as close to it as possible. */
function quietWhite(background: string, min: number): string {
  let lo = 0;
  let hi = 1;
  let best = WHITE;
  for (let step = 0; step < 22; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = mixSrgb(WHITE, background, mid);
    if (contrastRatio(candidate, background) >= min) {
      best = candidate;
      hi = mid;
    } else lo = mid;
  }
  return contrastRatio(best, background) >= min ? best : WHITE;
}

function darkInkOn(fill: string): string {
  return contrastRatio(INK, fill) >= BUBBLE_TEXT_MIN ? INK : WHITE;
}

export function userBubbleTone(color: MausColor): UserBubbleTone {
  const palette = MAUS_COLORS[color];
  const background = toneForSurface(palette, WHITE, BUBBLE_TEXT_MIN);
  const secondary = quietWhite(background, Math.min(6.2, Math.max(BUBBLE_TEXT_MIN, contrastRatio(WHITE, background) - 0.6)));
  let tertiary = quietWhite(background, BUBBLE_TEXT_MIN);
  if (contrastRatio(tertiary, background) > contrastRatio(secondary, background)) tertiary = secondary;
  // A chip well, darker than the fill so it separates, still dark enough for white.
  let inset = mixSrgb("#000000", background, 0.2);
  if (contrastRatio(WHITE, inset) < BUBBLE_TEXT_MIN) inset = background;
  if (contrastRatio(secondary, inset) < BUBBLE_TEXT_MIN) inset = background;
  const panel = mixSrgb(inset, background, 0.45);
  // Hover fills lift a little, but not so far that white text drops under AA.
  let raised = mixSrgb(WHITE, background, 0.1);
  if (contrastRatio(WHITE, raised) < BUBBLE_TEXT_MIN) raised = background;
  let raisedHover = mixSrgb(WHITE, background, 0.16);
  if (contrastRatio(WHITE, raisedHover) < BUBBLE_TEXT_MIN) raisedHover = raised;
  const hairline = lightEnough(mixSrgb(WHITE, background, 0.45), background, UI_MIN);
  // Links and the send button. A light accent of this hue, with a dark label.
  let accent = lightEnough(palette, background, BUBBLE_TEXT_MIN);
  if (contrastRatio(accent, raised) < BUBBLE_TEXT_MIN) accent = lightEnough(accent, raised, BUBBLE_TEXT_MIN);
  if (contrastRatio(INK, accent) < BUBBLE_TEXT_MIN) accent = lightEnough(accent, INK, BUBBLE_TEXT_MIN);
  const danger = lightEnough("#ff6d80", background, BUBBLE_TEXT_MIN);
  const success = lightEnough("#7ddead", background, BUBBLE_TEXT_MIN);
  return {
    background,
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
  };
}

/** Chip behind an @mention on a colored bubble: white text on a tint of the named bot. */
export function mentionChipBackground(mention: string, inset: string): string {
  return mixSrgb(mention, inset, MENTION_CHIP_MIX);
}

export function selectionBackground(background: string): string {
  return mixSrgb("#000000", background, SELECTION_BLACK_MIX);
}

/** Quote strip: inset at 70% over the fill, as `bg-inset/70` paints it. */
export function quoteSurface(inset: string, background: string): string {
  return mixSrgb(inset, background, 0.7);
}

export function userBubbleStyle(color: MausColor): CSSProperties {
  const tone = userBubbleTone(color);
  return {
    backgroundColor: tone.background,
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
  } as CSSProperties;
}
