// Generates the iOS app icon, matching the desktop one in build/icon.svg.
//
//   node scripts/make-app-icon.mjs
//
// Same artwork, two differences that iOS requires:
//
//   - **Full bleed.** The macOS icon grid puts an 824-unit tile inside a
//     1024 canvas with its own rounded corners, because a full-bleed tile
//     renders noticeably larger than everything else in the Dock. iOS masks
//     the corners itself and expects art to reach the edge, so the grid inset
//     and the rounded clip are dropped here.
//   - **No alpha.** The App Store rejects an icon with an alpha channel.
//
// Everything is drawn by hand — bezier flattening, scanline fill, the PNG
// encoder — because the alternative is an image-processing dependency in a
// project that has none, for a file that changes about never. The numbers
// below mirror build/icon.svg; if that changes, change these.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "ios", "App", "Assets.xcassets", "AppIcon.appiconset");
const SIZE = 1024;
const SS = 4; // supersampling; 4 is plenty at this size

// ── the artwork, from build/icon.svg ───────────────────────────────────
const TILE_STOPS = [
  { at: 0, color: [0x20, 0x22, 0x27] },
  { at: 0.56, color: [0x13, 0x14, 0x19] },
  { at: 1, color: [0x09, 0x0a, 0x0d] },
];
const MASCOT_STOPS = [
  { at: 0, color: [0xff, 0xff, 0xff] },
  { at: 0.28, color: [0xe6, 0xe8, 0xeb] },
  { at: 0.58, color: [0xb7, 0xbb, 0xc2] },
  { at: 0.82, color: [0x84, 0x8a, 0x94] },
  { at: 1, color: [0x5b, 0x61, 0x6b] },
];
const FACE = [0x10, 0x11, 0x14];

const MASCOT =
  "M93.4 40.6 L43 151.1 Q38 162 48.4 156 L91.4 131 Q100 126 108.7 131 " +
  "L151.6 156 Q162 162 157 151.1 L106.6 40.6 Q100 26 93.4 40.6 Z";
const SMILE = "M86 106 Q101 124 117 105";
const SMILE_WIDTH = 7;
const EYES = [
  { x: 84.5, y: 75, w: 9, h: 24, r: 4.5, spin: -15, about: [89, 87] },
  { x: 108.5, y: 75, w: 9, h: 24, r: 4.5, spin: -7, about: [113, 87] },
];

// `<svg x="-260" y="-140" width="1300" height="1300" viewBox="10 10 180 180">`
// maps the artwork's own coordinates onto the canvas; the group inside is
// rotated 25° about (100,100) first.
const VIEW_SCALE = 1300 / 180;
const artToCanvas = ([x, y]) => [(x - 10) * VIEW_SCALE - 260, (y - 10) * VIEW_SCALE - 140];
const rotate = ([x, y], degrees, [cx, cy]) => {
  const a = (degrees * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
};
/** Artwork point → canvas, through the 25° group rotation. */
const place = (point) => artToCanvas(rotate(point, 25, [100, 100]));

// ── path handling ──────────────────────────────────────────────────────
/** M/L/Q/Z absolute, which is all build/icon.svg uses. */
function flatten(d, steps = 32) {
  const tokens = d.match(/[MLQZmlqz]|-?\d*\.?\d+/g) ?? [];
  const points = [];
  let cursor = [0, 0];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i];
    if (command === "M" || command === "L") {
      cursor = [+tokens[i + 1], +tokens[i + 2]];
      points.push(cursor);
      i += 3;
    } else if (command === "Q") {
      const control = [+tokens[i + 1], +tokens[i + 2]];
      const end = [+tokens[i + 3], +tokens[i + 4]];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        points.push([
          u * u * cursor[0] + 2 * u * t * control[0] + t * t * end[0],
          u * u * cursor[1] + 2 * u * t * control[1] + t * t * end[1],
        ]);
      }
      cursor = end;
      i += 5;
    } else {
      i += 1;
    }
  }
  return points;
}

/** A rounded rect as a polygon, in its own coordinates. */
function roundedRect({ x, y, w, h, r }, steps = 10) {
  const points = [];
  const corners = [
    [x + w - r, y + r, -90, 0],
    [x + w - r, y + h - r, 0, 90],
    [x + r, y + h - r, 90, 180],
    [x + r, y + r, 180, 270],
  ];
  for (const [cx, cy, from, to] of corners) {
    for (let s = 0; s <= steps; s++) {
      const a = ((from + ((to - from) * s) / steps) * Math.PI) / 180;
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return points;
}

/** A stroked polyline as a fillable polygon: one side up, the other back,
 *  with round caps approximated by the joint circles below. */
function strokeToPolygons(points, width) {
  const half = width / 2;
  const polys = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    polys.push([
      [x0 + nx, y0 + ny],
      [x1 + nx, y1 + ny],
      [x1 - nx, y1 - ny],
      [x0 - nx, y0 - ny],
    ]);
  }
  // round joins and caps
  for (const [x, y] of points) {
    const circle = [];
    for (let a = 0; a < 24; a++) {
      const t = (a / 24) * Math.PI * 2;
      circle.push([x + Math.cos(t) * half, y + Math.sin(t) * half]);
    }
    polys.push(circle);
  }
  return polys;
}

/** Even-odd would hole out overlapping stroke quads, so: coverage by union. */
function rasterise(polygons, width) {
  const mask = new Uint8Array(width * width);
  for (const poly of polygons) {
    const ys = poly.map((p) => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(width - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y++) {
      const sy = y + 0.5;
      const xs = [];
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        if (y0 === y1) continue;
        if (sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
        xs.push(x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] - 0.5));
        const to = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
        for (let x = from; x <= to; x++) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

const sample = (stops, t) => {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped <= stops[i + 1].at) {
      const a = stops[i];
      const b = stops[i + 1];
      const local = (clamped - a.at) / (b.at - a.at || 1);
      return a.color.map((c, k) => c + (b.color[k] - c) * local);
    }
  }
  return stops[stops.length - 1].color;
};

// ── draw ───────────────────────────────────────────────────────────────
const big = SIZE * SS;
const toBig = ([x, y]) => [(x / 1024) * big, (y / 1024) * big];

const bodyPoly = flatten(MASCOT).map(place).map(toBig);
const eyePolys = EYES.map((eye) =>
  roundedRect(eye)
    .map((p) => rotate(p, eye.spin, eye.about))
    .map(place)
    .map(toBig),
);
const smilePolys = strokeToPolygons(
  flatten(SMILE).map(place).map(toBig),
  // stroke width travels through the same scale the artwork does
  (SMILE_WIDTH * VIEW_SCALE * big) / 1024,
);

const bodyMask = rasterise([bodyPoly], big);
const faceMask = rasterise([...eyePolys, ...smilePolys], big);

// the mascot's linear gradient runs 18%,10% → 84%,94% of its own bounding box
const bx = bodyPoly.map((p) => p[0]);
const by = bodyPoly.map((p) => p[1]);
const bounds = { x0: Math.min(...bx), x1: Math.max(...bx), y0: Math.min(...by), y1: Math.max(...by) };
const gradFrom = [bounds.x0 + (bounds.x1 - bounds.x0) * 0.18, bounds.y0 + (bounds.y1 - bounds.y0) * 0.1];
const gradTo = [bounds.x0 + (bounds.x1 - bounds.x0) * 0.84, bounds.y0 + (bounds.y1 - bounds.y0) * 0.94];
const gradVec = [gradTo[0] - gradFrom[0], gradTo[1] - gradFrom[1]];
const gradLenSq = gradVec[0] ** 2 + gradVec[1] ** 2;

// the tile's radial gradient: 68%,36% of the canvas, radius 92%
const tileCentre = [big * 0.68, big * 0.36];
const tileRadius = big * 0.92;

const rgb = Buffer.alloc(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x * SS + sx;
        const py = y * SS + sy;
        const index = py * big + px;
        let colour;
        if (faceMask[index] && bodyMask[index]) {
          colour = FACE;
        } else if (bodyMask[index]) {
          const t =
            ((px - gradFrom[0]) * gradVec[0] + (py - gradFrom[1]) * gradVec[1]) / (gradLenSq || 1);
          colour = sample(MASCOT_STOPS, t);
        } else {
          const d = Math.hypot(px - tileCentre[0], py - tileCentre[1]) / tileRadius;
          colour = sample(TILE_STOPS, d);
        }
        acc = acc.map((c, i) => c + colour[i]);
      }
    }
    const at = (y * SIZE + x) * 3;
    const samples = SS * SS;
    rgb[at] = Math.round(acc[0] / samples);
    rgb[at + 1] = Math.round(acc[1] / samples);
    rgb[at + 2] = Math.round(acc[2] / samples);
  }
}

// ── PNG ────────────────────────────────────────────────────────────────
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "icon-1024.png"), encodePng(rgb, SIZE));
writeFileSync(
  join(OUT_DIR, "Contents.json"),
  JSON.stringify(
    {
      images: [{ filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${SIZE}×${SIZE} icon to ios/App/Assets.xcassets/AppIcon.appiconset/`);
