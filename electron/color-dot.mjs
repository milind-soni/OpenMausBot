// A coloured dot for native menus (the Cloud switcher, the lending icon's menu), drawn as a PNG without a canvas.
import { deflateSync } from "node:zlib";

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** A filled circle with a soft edge, as a PNG data URL (straight RGBA, so no platform's pixel order matters). */
export function colorDotPng(hex, size, diameter = size * 0.72) {
  const [red, green, blue] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16));
  const rows = Buffer.alloc(size * (size * 4 + 1)), center = size / 2, radius = diameter / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x + 0.5 - center, y + 0.5 - center)));
      rows.set([red, green, blue, Math.round(alpha * 255)], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Each mascot colour in the default skin (src/lib/mascot.ts MAUS_COLORS), for a bot's dot in a native menu. */
export const BOT_COLOR_HEX = Object.freeze({ green: "#009957", blue: "#377FE6", red: "#D94B52", orange: "#E78531", purple: "#8057C8", cyan: "#0EA5C6",
  pink: "#D84F8B", yellow: "#D8A729", teal: "#01A492", coral: "#E5634E", silver: "#A8ADB4", chrome: "#B3BAC4" });

/** A menu dot for each colour named in `hexes` (14 pt, sharp at 2x), drawn once per colour; null where it cannot be drawn. */
export function dotIcons(nativeImage, hexes = BOT_COLOR_HEX) {
  const made = new Map();
  return color => {
    if (typeof color !== "string" || !Object.hasOwn(hexes, color)) return null;
    if (!made.has(color)) {
      try {
        const image = nativeImage.createEmpty();
        for (const scaleFactor of [1, 2]) image.addRepresentation({ scaleFactor, dataURL: colorDotPng(hexes[color], 14 * scaleFactor) });
        made.set(color, image.isEmpty() ? null : image);
      } catch { made.set(color, null); }
    }
    return made.get(color) ?? null;
  };
}
