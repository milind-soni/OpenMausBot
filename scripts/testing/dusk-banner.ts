// A banner picture for scripts/verify-cloud-rail.ts, drawn here (a dusk sky over two hills, no file needed); the script
// keeps it on the fixture server through the server's own route, as the app's upload would.
import { deflateSync } from "node:zlib";

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** A dusk sky over two hills, as a PNG. */
export function duskPng(width = 960, height = 320): Buffer {
  const rows = Buffer.alloc(height * (width * 3 + 1));
  const mix = (a: number[], b: number[], t: number) => a.map((value, i) => Math.round(value + (b[i]! - value) * t));
  for (let y = 0; y < height; y++) {
    const sky = y / height < 0.5 ? mix([52, 72, 140], [236, 120, 98], (y / height) / 0.5) : mix([236, 120, 98], [250, 196, 120], (y / height - 0.5) / 0.5);
    for (let x = 0; x < width; x++) {
      const far = height * (0.62 + 0.08 * Math.sin(x / 90)), near = height * (0.78 + 0.07 * Math.sin(x / 140 + 2));
      const sun = Math.hypot(x - width * 0.7, y - height * 0.5) < height * 0.12;
      const color = y > near ? [40, 46, 70] : y > far ? [78, 76, 110] : sun ? [255, 226, 160] : sky;
      rows.set(color, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
