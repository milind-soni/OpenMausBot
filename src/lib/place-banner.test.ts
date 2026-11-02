import { afterEach, expect, it, vi } from "vitest";

const sent: Array<{ path: string; init: RequestInit | undefined }> = [];
let answer: () => Promise<unknown> = async () => ({});
vi.mock("@/state/api", () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly body?: Record<string, unknown>) { super(message); }
  }
  return { ApiError, api: vi.fn(async (path: string, init?: RequestInit) => { sent.push({ path, init }); return answer(); }) };
});
const { ApiError } = await import("@/state/api");
const { BANNER_MAX_BYTES, bannerScale, bannerSrc, pictureKind, prepareBanner, removeBanner, uploadBanner } = await import("./place-banner");

afterEach(() => { sent.length = 0; answer = async () => ({}); });

const PNG_HEAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_HEAD = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
const file = (head: Uint8Array, size = 2048) => new Blob([new Uint8Array(head), new Uint8Array(Math.max(0, size - head.length))]);

/** A browser's canvas as the test needs it: what was drawn, at what size, and blobs of the size `sizeOf` says. */
function tools({ width = 4000, height = 1000, webp = true, sizeOf = (_w: number, _h: number, _q: number): number => 100_000, unreadable = false } = {}) {
  const drawn: Array<{ width: number; height: number; type: string; quality: number }> = [];
  let closed = false;
  return {
    drawn, closed: () => closed,
    read: async () => { if (unreadable) throw new Error("bad"); return { width, height, close: () => { closed = true; } } as never; },
    canvas: (w: number, h: number) => ({
      context: { drawImage() {}, fillRect() {}, fillStyle: "", imageSmoothingQuality: "low" } as unknown as CanvasRenderingContext2D,
      encode: async (type: string, quality: number) => {
        const made = type === "image/webp" && !webp ? "image/png" : type;
        drawn.push({ width: w, height: h, type: made, quality });
        return new Blob([new Uint8Array(sizeOf(w, h, quality))], { type: made });
      },
    }),
  };
}

it("a picture's kind comes from its first bytes; anything but PNG, JPEG or WebP is refused before it is read", async () => {
  expect([PNG_HEAD, JPEG_HEAD, WEBP_HEAD].map(pictureKind)).toEqual(["image/png", "image/jpeg", "image/webp"]);
  for (const head of [new TextEncoder().encode("GIF89a"), new TextEncoder().encode("<svg"), new Uint8Array()]) expect(pictureKind(head)).toBeNull();
  const fake = tools();
  expect(await prepareBanner(file(new TextEncoder().encode("<svg xmlns=")), fake)).toEqual({ ok: false, problem: "format" });
  expect(fake.drawn).toEqual([]);
  expect(await prepareBanner(file(PNG_HEAD), tools({ unreadable: true }))).toEqual({ ok: false, problem: "read" });
});

it("shrunk to 1600 px across at most and drawn afresh as WebP under 400 KB, a little softer each try until it fits", async () => {
  expect([bannerScale(4000, 1000), bannerScale(800, 300), bannerScale(1000, 3200)]).toEqual([0.4, 1, 0.5]);
  const fake = tools({ sizeOf: (_w, _h, quality) => (quality > 0.7 ? BANNER_MAX_BYTES + 1 : 300_000) });
  const prepared = await prepareBanner(file(PNG_HEAD), fake);
  expect(prepared.ok && prepared.blob.type).toBe("image/webp");
  expect(fake.drawn.map((draw) => [draw.width, draw.height, draw.quality])).toEqual([[1600, 400, 0.86], [1600, 400, 0.78], [1600, 400, 0.7]]);
  expect(fake.closed()).toBe(true);
});

it("a browser that can't write WebP sends JPEG; one too big at every try is said plainly", async () => {
  const jpeg = tools({ webp: false, width: 900, height: 300 });
  const prepared = await prepareBanner(file(JPEG_HEAD), jpeg);
  expect(prepared.ok && prepared.blob.type).toBe("image/jpeg");
  expect(jpeg.drawn.map((draw) => draw.type)).toEqual(["image/png", "image/jpeg"]);
  const huge = tools({ sizeOf: () => BANNER_MAX_BYTES + 1 });
  expect(await prepareBanner(file(WEBP_HEAD), huge)).toEqual({ ok: false, problem: "size" });
  expect(huge.drawn.at(-1)!.width, "it shrinks further before it gives up").toBeLessThan(1600);
});

it("the banner's address changes with each picture, and a malformed version is no address", () => {
  expect(bannerSrc({ version: "abc_DEF-123", width: 1, height: 1 })).toBe("/api/workspace/banner?v=abc_DEF-123");
  for (const bad of [null, undefined, { version: "../x", width: 1, height: 1 }, { version: "", width: 1, height: 1 }]) expect(bannerSrc(bad as never)).toBeNull();
});

it("the upload sends the prepared bytes as they are; the server's refusal comes back in this page's words", async () => {
  const blob = new Blob([new Uint8Array(10)], { type: "image/webp" });
  expect(await uploadBanner(blob)).toEqual({ ok: true });
  expect(sent[0]).toMatchObject({ path: "/api/workspace/banner", init: { method: "PUT", body: blob, headers: { "content-type": "image/webp" } } });
  for (const [refusal, problem] of [["format", "format"], ["size", "size"], ["dimensions", "size"], ["animated", "animated"], ["damaged", "read"], [undefined, "failed"]] as const) {
    answer = async () => { throw new ApiError("no", 415, refusal ? { refusal } : {}); };
    expect(await uploadBanner(blob)).toEqual({ ok: false, problem });
  }
  answer = async () => ({ banner: null });
  expect(await removeBanner()).toEqual({ ok: true });
  expect(sent.at(-1)).toMatchObject({ path: "/api/workspace/banner", init: { method: "DELETE" } });
});
