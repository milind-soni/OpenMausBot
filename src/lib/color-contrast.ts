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

export function contrastRatio(a: string, b: string): number {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  const hi = Math.max(left, right);
  const lo = Math.min(left, right);
  return (hi + 0.05) / (lo + 0.05);
}

export type Oklch = { l: number; c: number; h: number };

export function toOklch(hex: string): Oklch {
  const { r, g, b } = parseHex(hex);
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.hypot(a, bb),
    h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  };
}

function oklchToLinear(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
}

export function fromOklch({ l, c, h }: Oklch): string {
  const fits = (chroma: number) => oklchToLinear(l, chroma, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let chroma = c;
  if (!fits(c)) {
    let lo = 0;
    let hi = c;
    for (let step = 0; step < 30; step += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    chroma = lo;
  }
  const encode = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  };
  const [r, g, b] = oklchToLinear(l, chroma, h).map(encode);
  return toHex({ r: r!, g: g!, b: b! });
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

export function toneForSurface(hex: string, surface: string, min = 4.5): string {
  if (contrastRatio(hex, surface) >= min) return hex;
  const [h, s, l] = rgbToHsl(parseHex(hex));
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
  let nudged = best;
  const toward = towardLight ? "#ffffff" : "#000000";
  for (let step = 0; step < 24 && contrastRatio(nudged, surface) < min; step += 1) {
    nudged = mixSrgb(toward, nudged, 0.08);
  }
  return nudged;
}
