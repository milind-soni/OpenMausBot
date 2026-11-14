type Rgb = readonly [number, number, number];

const PITCH = 3;
const DOT = 2;
const LEVELS = 5;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

const DEEP: Rgb = [0.02, 0.22, 0.12];
const GREEN: Rgb = [0.05, 0.55, 0.26];
const TEAL: Rgb = [0.1, 0.78, 0.62];
const CORE: Rgb = [0.92, 1, 0.8];
const LIME: Rgb = [0.8, 0.95, 0.25];
const VIOLET: Rgb = [0.55, 0.36, 1];
const PLUM: Rgb = [0.25, 0.1, 0.45];

/** The band's centre line as y/h = A + B·(x/w) + C·(x/w)², falling from the top left to the lower right. */
const CURVE = { a: -0.087, b: 1.157, c: -0.262 } as const;
const REFERENCE_HEIGHT = 1162;

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

function scale(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bandLight(x: number, y: number, w: number, h: number): Rgb {
  const u = x / w;
  const s = h / REFERENCE_HEIGHT;
  const centre = h * (CURVE.a + CURVE.b * u + CURVE.c * u * u);
  const slope = (h / w) * (CURVE.b + 2 * CURVE.c * u);
  const d = (y - centre) / Math.sqrt(1 + slope * slope) / s;
  const along = 0.7 + 0.3 * Math.exp(-(((x / s - 820) / 800) ** 2));
  const rays = 0.82 + 0.18 * Math.sin(d * 0.11 + Math.sin(x * 0.004) * 3) + 0.08 * Math.sin(d * 0.37 + x * 0.002);
  let light: Rgb;
  if (d < 0) {
    const t = Math.exp(d / 250);
    light = scale(mix(DEEP, mix(GREEN, TEAL, Math.exp(d / 80)), Math.min(1, t * 1.5)), t * 1.55);
  } else {
    const t = Math.exp(-d / 130);
    light = scale(mix(PLUM, mix(VIOLET, LIME, Math.exp(-d / 14)), Math.min(1, Math.exp(-d / 40) * 1.1 + t * 0.5)), t * 1.5);
  }
  return scale(mix(light, CORE, Math.exp(-((d / 24) ** 2)) * 0.85), along * rays);
}

export function drawAuroraField(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const random = seeded(7);
  ctx.fillStyle = "#080908";
  ctx.fillRect(0, 0, w, h);
  for (let y = 0, row = 0; y < h; y += PITCH, row++) {
    for (let x = 0, col = 0; x < w; x += PITCH, col++) {
      let [r, g, b] = bandLight(x, y, w, h);
      if (random() < 0.45) {
        const hue = random();
        const base = 0.05 + 0.09 * random();
        r += base * (hue < 0.33 ? 1.4 : 0.6);
        g += base * (hue > 0.33 && hue < 0.66 ? 1.3 : 0.7);
        b += base * (hue > 0.66 ? 1.2 : 0.7);
      }
      const threshold = BAYER[(row & 3) * 4 + (col & 3)]!;
      const level = (v: number) => Math.round((Math.floor(Math.min(1, Math.max(0, v)) * LEVELS + threshold) / LEVELS) * 255);
      const q = [level(r), level(g), level(b)];
      if (q[0]! + q[1]! + q[2]! < 6) continue;
      ctx.fillStyle = `rgb(${q[0]},${q[1]},${q[2]})`;
      ctx.fillRect(x, y, DOT, DOT);
    }
  }
  ctx.globalCompositeOperation = "lighter";
  ctx.filter = "blur(36px)";
  ctx.globalAlpha = 0.34;
  ctx.drawImage(ctx.canvas, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  const fade = ctx.createLinearGradient(0, h * 0.55, 0, h);
  fade.addColorStop(0, "rgb(8 9 8 / 0)");
  fade.addColorStop(1, "rgb(8 9 8 / 0.55)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, w, h);
}

let painted = false;

// shortcut: drawn once at the first screen's size; on a larger display the ground shows past its edge. Redraw on a
// screen change if that is ever noticed.
export function paintAuroraField(): void {
  if (painted || typeof document === "undefined") return;
  const w = Math.ceil(Math.max(window.screen?.width ?? 0, window.innerWidth));
  const h = Math.ceil(Math.max(window.screen?.height ?? 0, window.innerHeight));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx || !w || !h) return;
  painted = true;
  drawAuroraField(ctx, w, h);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const root = document.documentElement.style;
    root.setProperty("--aurora-field", `url(${URL.createObjectURL(blob)})`);
    root.setProperty("--aurora-field-size", `${w}px ${h}px`);
  });
}
