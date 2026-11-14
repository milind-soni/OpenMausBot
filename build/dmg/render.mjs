import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGB_BYTES = 3;
// Finder sizes the background by its dpi while dmg-builder (electron-builder 26.15.3) sizes the window by
// its pixels, so both images carry 72 dpi; `tiffutil -cathidpicheck` marks the @2x as 144 dpi in the TIFF.
const PIXELS_PER_METRE_AT_72_DPI = 2835;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function predict(filter, left, up, upLeft) {
  switch (filter) {
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      return 0;
  }
}

function filterRow(row, previous) {
  let best = null;
  for (let filter = 0; filter <= 4; filter++) {
    const filtered = Buffer.alloc(row.length + 1);
    filtered[0] = filter;
    let cost = 0;
    for (let i = 0; i < row.length; i++) {
      const left = i >= RGB_BYTES ? row[i - RGB_BYTES] : 0;
      const upLeft = i >= RGB_BYTES ? previous[i - RGB_BYTES] : 0;
      const value = (row[i] - predict(filter, left, previous[i], upLeft)) & 0xff;
      filtered[i + 1] = value;
      cost += value < 128 ? value : 256 - value;
    }
    if (!best || cost < best.cost) best = { filtered, cost };
  }
  return best.filtered;
}

function encodeOpaquePng(width, height, rgba) {
  const stride = width * RGB_BYTES;
  const rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      // Finder shows its own window colour through transparent pixels.
      if (rgba[source + 3] !== 255) throw new Error(`background.svg leaves pixel ${x},${y} transparent`);
      rgba.copy(row, x * RGB_BYTES, source, source + RGB_BYTES);
    }
    rows.push(filterRow(row, previous));
    previous = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const density = Buffer.alloc(9);
  density.writeUInt32BE(PIXELS_PER_METRE_AT_72_DPI, 0);
  density.writeUInt32BE(PIXELS_PER_METRE_AT_72_DPI, 4);
  density[8] = 1;
  const pixels = deflateSync(Buffer.concat(rows), { level: 9, memLevel: 9 });
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("pHYs", density), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

const svg = readFileSync(new URL("background.svg", import.meta.url), "utf8");
for (const [scale, name] of [
  [1, "background.png"],
  [2, "background@2x.png"],
]) {
  const image = new Resvg(svg, { fitTo: { mode: "zoom", value: scale }, font: { loadSystemFonts: false } }).render();
  const png = encodeOpaquePng(image.width, image.height, image.pixels);
  writeFileSync(new URL(`../${name}`, import.meta.url), png);
  console.log(`build/${name}: ${image.width}x${image.height}, ${png.length} bytes`);
}
