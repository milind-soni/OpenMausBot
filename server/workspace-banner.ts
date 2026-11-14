// A workspace's banner picture: the person's own image at the top of every sidebar of that workspace, kept on the
// workspace's own server (a Cloud or a server of theirs alike). The app shrinks and re-encodes a picture before it
// uploads it; the server never trusts that and checks it again here: a PNG, JPEG or WebP only, still, at most 1600 px
// across and BANNER_MAX_BYTES, and with every chunk or segment that can carry metadata (camera, place, editor, colour
// profile, text) taken out. No decoder runs on the server: the file is read only as far as its own structure.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const BANNER_MAX_BYTES = 400 * 1024;
export const BANNER_MAX_SIDE = 1600;
export type BannerMime = "image/png" | "image/jpeg" | "image/webp";
export interface CheckedBanner { bytes: Buffer; mime: BannerMime; width: number; height: number }
export type BannerRefusal = "format" | "size" | "dimensions" | "animated" | "damaged";
export type BannerCheck = ({ ok: true } & CheckedBanner) | { ok: false; refusal: BannerRefusal };

/** The plain sentence each refusal is said in. */
export const BANNER_REFUSALS: Readonly<Record<BannerRefusal, string>> = Object.freeze({
  format: "Use a PNG, JPEG or WebP picture.",
  size: "Use a picture of 400 KB or less.",
  dimensions: "Use a picture of at most 1600 pixels across.",
  animated: "Use a still picture.",
  damaged: "That picture couldn't be read. Try another one.",
});

class Damaged extends Error {}
class Animated extends Error {}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function bannerMime(bytes: Buffer): BannerMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** PNG: the chunks a still picture needs, and nothing that carries text, time or a colour profile. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "bKGD", "IDAT", "IEND"]);
function cleanPng(bytes: Buffer): CheckedBanner {
  const kept: Buffer[] = [PNG_SIGNATURE];
  let at = 8, width = 0, height = 0, ended = false, first = true;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Damaged();
    const length = bytes.readUInt32BE(at), type = bytes.toString("latin1", at + 4, at + 8), end = at + 12 + length;
    if (length > bytes.length || end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) throw new Damaged();
    if (first && type !== "IHDR") throw new Damaged();
    if (type === "IHDR") {
      if (length !== 13) throw new Damaged();
      width = bytes.readUInt32BE(at + 8); height = bytes.readUInt32BE(at + 12);
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new Animated();
    if (PNG_KEEP.has(type)) kept.push(bytes.subarray(at, end));
    // A critical chunk this reader doesn't know: not a picture it can vouch for.
    else if (type[0] === type[0]!.toUpperCase()) throw new Damaged();
    first = false; at = end;
    if (type === "IEND") { ended = true; break; }
  }
  if (!ended || !width || !height) throw new Damaged();
  return { bytes: Buffer.concat(kept), mime: "image/png", width, height };
}

/** JPEG: every segment but APP1 to APP13, APP15 and comments (EXIF, XMP, ICC, maker notes, editor tags). APP0 (JFIF)
 * and APP14 (Adobe's colour transform) say how to read the pixels, so they stay. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const dropJpegSegment = (marker: number) => marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xee);
function cleanJpeg(bytes: Buffer): CheckedBanner {
  const kept: Buffer[] = [bytes.subarray(0, 2)];
  let at = 2, width = 0, height = 0, ended = false, frames = 0;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) throw new Damaged();
    while (at < bytes.length && bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined) throw new Damaged();
    if (marker === 0xd9) { kept.push(Buffer.from([0xff, 0xd9])); ended = true; break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { kept.push(Buffer.from([0xff, marker])); continue; }
    if (at + 2 > bytes.length) throw new Damaged();
    const length = bytes.readUInt16BE(at), end = at + length;
    if (length < 2 || end > bytes.length) throw new Damaged();
    if (SOF.has(marker)) {
      if (length < 7) throw new Damaged();
      height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); frames++;
    }
    if (!dropJpegSegment(marker)) kept.push(Buffer.concat([Buffer.from([0xff, marker]), bytes.subarray(at, end)]));
    at = end;
    if (marker !== 0xda) continue;
    // The scan's coded data runs to the next marker that is neither a stuffed 0xFF00 nor a restart.
    const start = at;
    while (at < bytes.length) {
      if (bytes[at] === 0xff && at + 1 < bytes.length && bytes[at + 1] !== 0x00 && !(bytes[at + 1]! >= 0xd0 && bytes[at + 1]! <= 0xd7)) break;
      at++;
    }
    kept.push(bytes.subarray(start, at));
  }
  if (!ended || !width || !height || frames !== 1) throw new Damaged();
  return { bytes: Buffer.concat(kept), mime: "image/jpeg", width, height };
}

/** WebP: the picture's own chunks (VP8, VP8L, its alpha) under a VP8X header told there is no profile, EXIF or XMP. */
const WEBP_ICC = 0x20, WEBP_EXIF = 0x08, WEBP_XMP = 0x04, WEBP_ANIMATION = 0x02;
function cleanWebp(bytes: Buffer): CheckedBanner {
  const riff = bytes.readUInt32LE(4);
  if (riff + 8 > bytes.length || riff < 4) throw new Damaged();
  const kept: Buffer[] = [];
  let at = 12, width = 0, height = 0, image = false;
  while (at + 8 <= riff + 8) {
    const fourcc = bytes.toString("latin1", at, at + 4), size = bytes.readUInt32LE(at + 4), end = at + 8 + size + (size % 2);
    if (end > riff + 8 + (size % 2) || at + 8 + size > bytes.length) throw new Damaged();
    const data = bytes.subarray(at + 8, at + 8 + size);
    if (fourcc === "ANIM" || fourcc === "ANMF") throw new Animated();
    if (fourcc === "VP8X") {
      if (size < 10) throw new Damaged();
      if (data[0]! & WEBP_ANIMATION) throw new Animated();
      width = data.readUIntLE(4, 3) + 1; height = data.readUIntLE(7, 3) + 1;
      const header = Buffer.from(bytes.subarray(at, Math.min(end, bytes.length)));
      header[8] = data[0]! & ~(WEBP_ICC | WEBP_EXIF | WEBP_XMP);
      kept.push(header);
    } else if (fourcc === "VP8 ") {
      if (size < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new Damaged();
      if (!width) { width = data.readUInt16LE(6) & 0x3fff; height = data.readUInt16LE(8) & 0x3fff; }
      image = true; kept.push(bytes.subarray(at, Math.min(end, bytes.length)));
    } else if (fourcc === "VP8L") {
      if (size < 5 || data[0] !== 0x2f) throw new Damaged();
      if (!width) { const bits = data.readUInt32LE(1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      image = true; kept.push(bytes.subarray(at, Math.min(end, bytes.length)));
    } else if (fourcc === "ALPH") {
      kept.push(bytes.subarray(at, Math.min(end, bytes.length)));
    }
    at = end;
  }
  if (!image || !width || !height) throw new Damaged();
  const body = Buffer.concat(kept), header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(body.length + 4, 4); header.write("WEBP", 8, "latin1");
  return { bytes: Buffer.concat([header, body]), mime: "image/webp", width, height };
}

/** The upload as it may be kept, or why not, in words the person can act on. */
export function checkBanner(bytes: Buffer): BannerCheck {
  const mime = bannerMime(bytes);
  if (!mime) return { ok: false, refusal: "format" };
  if (bytes.length > BANNER_MAX_BYTES) return { ok: false, refusal: "size" };
  let checked: CheckedBanner;
  try {
    checked = mime === "image/png" ? cleanPng(bytes) : mime === "image/jpeg" ? cleanJpeg(bytes) : cleanWebp(bytes);
  } catch (error) {
    return { ok: false, refusal: error instanceof Animated ? "animated" : "damaged" };
  }
  if (checked.width > BANNER_MAX_SIDE || checked.height > BANNER_MAX_SIDE) return { ok: false, refusal: "dimensions" };
  return { ok: true, ...checked };
}

/** The banner a workspace keeps: its picture's name among the attachments, and its size. */
export interface StoredBanner { name: string; width: number; height: number }
/** A banner's picture is always one of these: a bare name in the attachments folder, never a path. */
export const BANNER_NAME = /^[A-Za-z0-9-]+\.(?:png|jpg|webp)$/;
const side = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= BANNER_MAX_SIDE;

/** Which attachment is the banner: workspace-banner.json in the data folder, beside the attachments (backed up with them). */
export function bannerRecord(file: string) {
  let cached: StoredBanner | null | undefined;
  return {
    current(): StoredBanner | null {
      if (cached !== undefined) return cached;
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredBanner> | null;
        cached = raw && typeof raw.name === "string" && BANNER_NAME.test(raw.name) && side(raw.width) && side(raw.height)
          ? { name: raw.name, width: raw.width!, height: raw.height! } : null;
      } catch { cached = null; }
      return cached;
    },
    set(next: StoredBanner | null): void {
      if (next) {
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        renameSync(temporary, file);
      } else rmSync(file, { force: true });
      cached = next;
    },
  };
}
