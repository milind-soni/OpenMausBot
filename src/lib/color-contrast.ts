// WCAG 2.x contrast for opaque sRGB colors. Shared by the user-bubble tone
// and the room name colors so both sides measure the same way.

export type Rgb = { r: number; g: number; b: number };

const HEX = /^#([0-9a-f]{6})$/i;

export function parseHex(value: string): Rgb {
  const hex = HEX.exec(value.trim())?.[1];
  if (!hex) throw new Error(`not a 6-digit hex colour: ${value}`);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function linear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Contrast of two opaque colors. Order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  const hi = Math.max(left, right);
  const lo = Math.min(left, right);
  return (hi + 0.05) / (lo + 0.05);
}

/** `weight` of `foreground` over `background`, matching CSS `color-mix(in srgb, A weight, B)`. */
export function mixSrgb(foreground: string, background: string, weight: number): string {
  const from = parseHex(foreground);
  const onto = parseHex(background);
  const blend = (a: number, b: number) => a * weight + b * (1 - weight);
  return toHex({ r: blend(from.r, onto.r), g: blend(from.g, onto.g), b: blend(from.b, onto.b) });
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
    case gn: h = (bn - rn) / d + 2; break;
    default: h = (rn - gn) / d + 4; break;
  }
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 };
}

/**
 * Move `hex` along its own hue until it clears `min` against `surface`.
 * Dark surfaces get a lighter shade, light surfaces a deeper one. The result
 * stays as close to the original lightness as the contrast allows.
 */
export function toneForSurface(hex: string, surface: string, min = 4.5): string {
  if (contrastRatio(hex, surface) >= min) return hex;
  const [h, s, l] = rgbToHsl(parseHex(hex));
  // A light page needs a deeper shade. A dark page needs a lighter one.
  const towardLight = relativeLuminance(surface) < 0.35;
  let lo = towardLight ? l : 0;
  let hi = towardLight ? 1 : l;
  let best = hex;
  for (let step = 0; step < 28; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = toHex(hslToRgb(h, s, mid));
    if (contrastRatio(candidate, surface) >= min) {
      best = candidate;
      if (towardLight) hi = mid;
      else lo = mid;
    } else if (towardLight) lo = mid;
    else hi = mid;
  }
  if (contrastRatio(best, surface) >= min) return best;
  // Hue at the extreme still short (a near-grey). Step toward black or white.
  let nudged = best;
  const toward = towardLight ? "#ffffff" : "#000000";
  for (let step = 0; step < 24 && contrastRatio(nudged, surface) < min; step += 1) {
    nudged = mixSrgb(toward, nudged, 0.08);
  }
  return nudged;
}

