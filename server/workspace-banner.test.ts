import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BANNER_MAX_BYTES, BANNER_REFUSALS, bannerMime, checkBanner } from "./workspace-banner.ts";

/** Small pictures a real encoder made, each carrying a camera make and model, a colour profile and text (EXIF, ICC, and a
 * comment or XMP or text chunks). */
const sample = (name: string) => readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url));
const JPEG_WITH_METADATA = sample("banner-metadata.jpg"), WEBP_WITH_METADATA = sample("banner-metadata.webp"), PNG_WITH_METADATA = sample("banner-metadata.png");

const has = (bytes: Buffer, text: string) => bytes.includes(Buffer.from(text, "latin1"));
const kept = (bytes: Buffer) => { const result = checkBanner(bytes); if (!result.ok) throw new Error(result.refusal); return result; };

/** A PNG's chunk with a length and a (never checked) CRC. */
const chunk = (type: string, data: Buffer = Buffer.alloc(0)) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8);
  return out;
};
const withChunk = (png: Buffer, extra: Buffer) => Buffer.concat([png.subarray(0, 33), extra, png.subarray(33)]);
/** A WebP's chunk, padded to an even length. */
const riffChunk = (fourcc: string, data: Buffer) => {
  const out = Buffer.alloc(8 + data.length + (data.length % 2));
  out.write(fourcc, 0, "latin1"); out.writeUInt32LE(data.length, 4); data.copy(out, 8);
  return out;
};
const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat(chunks), head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1"); head.writeUInt32LE(body.length + 4, 4); head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
};

describe("a workspace's banner picture, as the server keeps it", () => {
  it("a PNG, JPEG or WebP keeps its pixels and loses its camera, place, profile and text", () => {
    for (const [sample, mime] of [[JPEG_WITH_METADATA, "image/jpeg"], [WEBP_WITH_METADATA, "image/webp"], [PNG_WITH_METADATA, "image/png"]] as const) {
      expect(has(sample, "Secret"), `${mime} sample carries metadata`).toBe(true);
      const result = kept(sample);
      expect([result.mime, result.width, result.height]).toEqual([mime, 12, 6]);
      for (const word of ["Secret", "Exif", "EXIF", "XMP", "ICC_PROFILE", "ICCP", "iCCP", "tEXt", "iTXt", "eXIf"]) expect(has(result.bytes, word), `${mime}: ${word}`).toBe(false);
      expect(result.bytes.length).toBeLessThan(sample.length);
    }
    // What a decoder needs stays: the JPEG's frame, tables, scan and end; the WebP's own picture, in a header that adds up.
    const jpeg = kept(JPEG_WITH_METADATA).bytes;
    expect([jpeg.subarray(0, 2).toString("hex"), jpeg.subarray(-2).toString("hex"), has(jpeg, "JFIF")]).toEqual(["ffd8", "ffd9", true]);
    const webp = kept(WEBP_WITH_METADATA).bytes;
    expect(webp.readUInt32LE(4) + 8).toBe(webp.length);
    expect(has(webp, "VP8")).toBe(true);
  });

  it("anything but a PNG, JPEG or WebP is refused in plain words, and so is one too big, too wide, moving or broken", () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    for (const bytes of [gif, svg, Buffer.from("not a picture"), Buffer.alloc(0)]) expect(checkBanner(bytes)).toEqual({ ok: false, refusal: "format" });
    expect(BANNER_REFUSALS.format).toBe("Use a PNG, JPEG or WebP picture.");
    expect(checkBanner(Buffer.concat([PNG_WITH_METADATA, Buffer.alloc(BANNER_MAX_BYTES)]))).toEqual({ ok: false, refusal: "size" });

    const wide = Buffer.from(PNG_WITH_METADATA); wide.writeUInt32BE(1601, 16);
    expect(checkBanner(wide)).toEqual({ ok: false, refusal: "dimensions" });
    const tall = Buffer.from(PNG_WITH_METADATA); tall.writeUInt32BE(4000, 20);
    expect(checkBanner(tall)).toEqual({ ok: false, refusal: "dimensions" });
    const atLimit = Buffer.from(PNG_WITH_METADATA); atLimit.writeUInt32BE(1600, 16);
    expect(checkBanner(atLimit).ok).toBe(true);

    expect(checkBanner(withChunk(PNG_WITH_METADATA, chunk("acTL", Buffer.alloc(8))))).toEqual({ ok: false, refusal: "animated" });
    const vp8x = Buffer.alloc(10); vp8x[0] = 0x02; vp8x.writeUIntLE(99, 4, 3); vp8x.writeUIntLE(49, 7, 3);
    expect(checkBanner(riff(riffChunk("VP8X", vp8x), riffChunk("ANIM", Buffer.alloc(6))))).toEqual({ ok: false, refusal: "animated" });
    const still = Buffer.from(vp8x); still[0] = 0;
    expect(checkBanner(riff(riffChunk("VP8X", still), riffChunk("ANIM", Buffer.alloc(6)), riffChunk("ANMF", Buffer.alloc(16)))), "frames under a header that says still")
      .toEqual({ ok: false, refusal: "animated" });

    expect(checkBanner(PNG_WITH_METADATA.subarray(0, 40))).toEqual({ ok: false, refusal: "damaged" });
    expect(checkBanner(JPEG_WITH_METADATA.subarray(0, JPEG_WITH_METADATA.length - 2)), "no end of image").toEqual({ ok: false, refusal: "damaged" });
    expect(checkBanner(withChunk(PNG_WITH_METADATA, chunk("ZZZZ"))), "a critical chunk it doesn't know").toEqual({ ok: false, refusal: "damaged" });
    expect(checkBanner(riff(riffChunk("EXIF", Buffer.from("Secret")))), "no picture in it at all").toEqual({ ok: false, refusal: "damaged" });
  });

  it("a picture's kind comes from its first bytes, never its name or claimed type", () => {
    expect([PNG_WITH_METADATA, JPEG_WITH_METADATA, WEBP_WITH_METADATA].map(bannerMime)).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(bannerMime(Buffer.from("RIFF\0\0\0\0WAVE", "latin1"))).toBeNull();
  });
});
