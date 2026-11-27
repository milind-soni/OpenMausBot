// Icons for a launcher: the app's own PNG when it sent a usable one, else a coloured tile with its first letter.
import { deflateSync } from "node:zlib";
import { appKey } from "./names.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_ICON_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 4096;

/** `{ width, height }` of a PNG within the size limits, or null for anything else. */
export function pngSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > MAX_ICON_BYTES) return null;
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null;
  return { width, height };
}

/** A Windows icon file holding one PNG image (Windows Vista and later read PNG entries); 256 and over is stored as 0. */
export function icoFromPng(png) {
  const size = pngSize(png);
  if (!size) throw new Error("not a PNG");
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size.width >= 256 ? 0 : size.width, 6);
  header.writeUInt8(size.height >= 256 ? 0 : size.height, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, Buffer.from(png)]);
}

/** The files `iconutil` expects in a .iconset folder, each with its side in pixels. */
export const MAC_ICONSET = [16, 32, 128, 256, 512].flatMap((side) => [
  { file: `icon_${side}x${side}.png`, px: side },
  { file: `icon_${side}x${side}@2x.png`, px: side * 2 },
]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// 5×7 capitals and digits, one string per glyph, rows top to bottom.
const GLYPHS = {
  A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110", C: "01110100011000010000100001000101110",
  D: "11110100011000110001100011000111110", E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
  G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001", I: "01110001000010000100001000010001110",
  J: "00111000100001000010000101001001100", K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001", N: "10001100011100110101100111000110001", O: "01110100011000110001100011000101110",
  P: "11110100011000111110100001000010000", Q: "01110100011000110001101011001001101", R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100", U: "10001100011000110001100011000101110",
  V: "10001100011000110001100010101000100", W: "10001100011000110101101011010101010", X: "10001100010101000100010101000110001",
  Y: "10001100010101000100001000010000100", Z: "11111000010001000100010001000011111",
  0: "01110100011001110101110011000101110", 1: "00100011000010000100001000010001110", 2: "01110100010000100010001000100011111",
  3: "11111000100010000010000011000101110", 4: "00010001100101010010111110001000010", 5: "11111100001111000001000011000101110",
  6: "00110010001000011110100011000101110", 7: "11111000010001000100010000100001000", 8: "01110100011000101110100011000101110",
  9: "01110100011000101111000010001001100",
};

const TILE_COLOURS = [[0x4f, 0x5b, 0xd5], [0x0f, 0x76, 0x6e], [0xb4, 0x53, 0x09], [0x9d, 0x17, 0x4d], [0x1d, 0x4e, 0xd8], [0x6d, 0x28, 0xd9], [0x15, 0x80, 0x3d]];

/** The glyph for a name's first letter or digit (accents dropped), or null when it has none in the 5×7 set. */
export function tileLetter(name) {
  const first = [...(typeof name === "string" ? name.normalize("NFD").replace(/\p{M}/gu, "") : "")].find((c) => /\S/u.test(c));
  const letter = first?.toUpperCase();
  return letter && GLYPHS[letter] ? letter : null;
}

/** A square PNG: a rounded tile in a colour picked from the app's id, with the name's first letter in white. */
export function letterTilePng({ id, name, size = 1024 }) {
  const rgba = Buffer.alloc(size * size * 4);
  const [r, g, b] = TILE_COLOURS[parseInt(appKey(String(id)).slice(0, 8), 16) % TILE_COLOURS.length];
  const inset = size * 0.1, side = size - inset * 2, radius = side * 0.225;
  const letter = tileLetter(name);
  const glyph = letter ? GLYPHS[letter] : null;
  const cell = Math.floor(side * 0.075), glyphLeft = Math.round((size - cell * 5) / 2), glyphTop = Math.round((size - cell * 7) / 2);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(inset + radius - (x + 0.5), x + 0.5 - (size - inset - radius), 0);
      const dy = Math.max(inset + radius - (y + 0.5), y + 0.5 - (size - inset - radius), 0);
      const coverage = Math.min(1, Math.max(0, radius - Math.hypot(dx, dy) + 0.5));
      if (coverage === 0) continue;
      const gx = Math.floor((x - glyphLeft) / cell), gy = Math.floor((y - glyphTop) / cell);
      const ink = glyph && x >= glyphLeft && y >= glyphTop && gx < 5 && gy < 7 && glyph[gy * 5 + gx] === "1";
      rgba.set(ink ? [255, 255, 255, Math.round(coverage * 255)] : [r, g, b, Math.round(coverage * 255)], (y * size + x) * 4);
    }
  }
  return encodePng(size, size, rgba);
}
