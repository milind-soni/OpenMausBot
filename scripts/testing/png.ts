// Reads the 8-bit, non-interlaced PNGs our fixtures keep: truecolour with or
// without alpha. Enough to paint a captured desktop into a synthetic
// framebuffer without pulling in an image library.
import { deflateSync, inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** RGB at (x, y); alpha is dropped. */
  pixel: (x: number, y: number) => [number, number, number];
}

export function decodePng(file: Buffer): DecodedPng {
  if (!file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("not a PNG");
  let width = 0, height = 0, channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = colour === 2 ? 3 : colour === 6 ? 4 : 0;
      if (depth !== 8 || !channels || interlace) throw new Error("only 8-bit non-interlaced truecolour PNGs are supported");
    } else if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    raw.copy(row, 0, at, at + stride);
    at += stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = above[i];
      const upLeft = i >= channels ? above[i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[i] = (row[i] + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const at = y * stride + x * channels;
      return [pixels[at], pixels[at + 1], pixels[at + 2]];
    },
  };
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** An 8-bit truecolour PNG of `width` x `height`, each pixel from `pixel`. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A part of a picture, each of its pixels drawn `zoom` times as wide and tall, so its edges can be seen pixel by pixel. */
export function zoomedCrop(file: Buffer, crop: { x: number; y: number; width: number; height: number }, zoom: number): Buffer {
  const picture = decodePng(file);
  return encodePng(crop.width * zoom, crop.height * zoom, (x, y) => picture.pixel(crop.x + Math.floor(x / zoom), crop.y + Math.floor(y / zoom)));
}
