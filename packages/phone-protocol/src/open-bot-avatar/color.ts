/** Minimal hex color handling for the renderer. Only #rgb / #rrggbb are accepted. */

export type Rgb = [number, number, number];

export function parseHex(input: unknown): Rgb | null {
  if (typeof input !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Darken while keeping the hue rich: blend toward a deeper, slightly
 * saturated version of the color rather than toward gray-black.
 */
export function shade(c: Rgb, t: number): Rgb {
  const max = Math.max(...c);
  const deep: Rgb = [c[0] * 0.35 - (max - c[0]) * 0.1, c[1] * 0.35 - (max - c[1]) * 0.1, c[2] * 0.35 - (max - c[2]) * 0.1];
  return mix(c, deep, t);
}

export function tint(c: Rgb, t: number): Rgb {
  return mix(c, [255, 255, 255], t);
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const DARK_INK: Rgb = [20, 22, 34];
export const LIGHT_INK: Rgb = [250, 250, 255];

/** Pick the eye ink with the best contrast against the body color. */
export function autoEyeColor(body: Rgb): Rgb {
  return contrast(body, DARK_INK) >= contrast(body, LIGHT_INK) ? DARK_INK : LIGHT_INK;
}

// OKLCH, for colors that look equally bright whatever their hue.

const toLinear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** A color as OKLCH: lightness 0..1, chroma, hue in degrees. */
export function toOklch(c: Rgb): [number, number, number] {
  const [r, g, b] = c.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return [L, Math.hypot(A, B), h < 0 ? h + 360 : h];
}

function oklchLinear(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** An OKLCH color in sRGB, its chroma lowered as far as it takes to fit (lightness and hue are kept). */
export function oklch(L: number, C: number, h: number): Rgb {
  const fits = (c: number) => oklchLinear(L, c, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lo = 0, hi = C;
  if (!fits(hi)) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  return oklchLinear(L, hi, h).map(fromLinear) as Rgb;
}
