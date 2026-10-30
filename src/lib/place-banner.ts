// The workspace's banner picture, as this page uploads and shows it. The picture is kept on the workspace's own server
// (server/routes/workspace-banner.ts), which checks it again; here it is shrunk to at most 1600 px across and drawn
// afresh as WebP (JPEG where the browser can't write WebP) under 400 KB, so nothing the file carried besides its
// pixels (camera, place, editor) is ever sent.

import { api, ApiError } from "@/state/api";

export const BANNER_PATH = "/api/workspace/banner";
export const BANNER_ACCEPT = "image/png,image/jpeg,image/webp";
export const BANNER_MAX_BYTES = 400 * 1024;
export const BANNER_MAX_SIDE = 1600;
const QUALITIES = [0.86, 0.78, 0.7, 0.6, 0.5];

export type BannerKind = "image/png" | "image/jpeg" | "image/webp";
/** Why a picture can't be used: not a PNG, JPEG or WebP; one this browser can't read; or one still too big. */
export type BannerProblem = "format" | "read" | "size";

/** The picture's own kind, from its first bytes: a file's name or claimed type is never trusted. */
export function pictureKind(head: Uint8Array): BannerKind | null {
  if (head.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, at) => head[at] === byte)) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const text = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** How far to shrink a picture so it is at most BANNER_MAX_SIDE across either way (never larger than it is). */
export function bannerScale(width: number, height: number): number {
  return Math.min(1, BANNER_MAX_SIDE / Math.max(1, width), BANNER_MAX_SIDE / Math.max(1, height));
}

interface Drawn { width: number; height: number; close?(): void }
export interface BannerTools {
  read(file: Blob): Promise<Drawn & CanvasImageSource>;
  canvas(width: number, height: number): { context: CanvasRenderingContext2D | null; encode(type: string, quality: number): Promise<Blob | null> };
}

const browserTools: BannerTools = {
  read: (file) => createImageBitmap(file),
  canvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    return { context: canvas.getContext("2d"), encode: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)) };
  },
};

/** The picture ready to upload, or why it can't be. */
export async function prepareBanner(file: Blob, tools: BannerTools = browserTools): Promise<{ ok: true; blob: Blob } | { ok: false; problem: BannerProblem }> {
  if (!pictureKind(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) return { ok: false, problem: "format" };
  let picture: Drawn & CanvasImageSource;
  try { picture = await tools.read(file); } catch { return { ok: false, problem: "read" }; }
  try {
    let scale = bannerScale(picture.width, picture.height);
    for (let shrink = 0; shrink < 4; shrink++, scale *= 0.75) {
      const width = Math.max(1, Math.round(picture.width * scale)), height = Math.max(1, Math.round(picture.height * scale));
      for (const quality of QUALITIES) {
        const surface = tools.canvas(width, height);
        if (!surface.context) return { ok: false, problem: "read" };
        surface.context.imageSmoothingQuality = "high";
        surface.context.drawImage(picture, 0, 0, width, height);
        let blob = await surface.encode("image/webp", quality);
        if (blob?.type !== "image/webp") {
          // A browser that can't write WebP: JPEG, on white where the picture was see-through.
          const flat = tools.canvas(width, height);
          if (!flat.context) return { ok: false, problem: "read" };
          flat.context.fillStyle = "#ffffff";
          flat.context.fillRect(0, 0, width, height);
          flat.context.drawImage(picture, 0, 0, width, height);
          blob = await flat.encode("image/jpeg", quality);
        }
        if (blob && blob.size <= BANNER_MAX_BYTES && (blob.type === "image/webp" || blob.type === "image/jpeg")) return { ok: true, blob };
      }
    }
    return { ok: false, problem: "size" };
  } finally {
    picture.close?.();
  }
}

/** What the server says of its banner (GET /api/config `workspaceBanner`): a version that changes with the picture. */
export interface BannerSummary { version: string; width: number; height: number }

/** The banner's address on this page's own server, new with each picture; none without one. */
export function bannerSrc(banner: BannerSummary | null | undefined): string | null {
  return banner && typeof banner.version === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(banner.version) ? `${BANNER_PATH}?v=${banner.version}` : null;
}

export type BannerOutcome = { ok: true } | { ok: false; problem: BannerProblem | "animated" | "failed" };
/** The server's refusal, in this page's words. */
function refused(error: unknown): BannerOutcome {
  const refusal = error instanceof ApiError ? error.body?.refusal : undefined;
  return { ok: false, problem: refusal === "format" ? "format" : refusal === "size" || refusal === "dimensions" ? "size" : refusal === "animated" ? "animated"
    : refusal === "damaged" ? "read" : "failed" };
}

/** Keeps the prepared picture as this workspace's banner; every open page hears of it from the server. */
export async function uploadBanner(blob: Blob): Promise<BannerOutcome> {
  try { await api(BANNER_PATH, { method: "PUT", headers: { "content-type": blob.type }, body: blob }); return { ok: true }; } catch (error) { return refused(error); }
}

export async function removeBanner(): Promise<BannerOutcome> {
  try { await api(BANNER_PATH, { method: "DELETE" }); return { ok: true }; } catch (error) { return refused(error); }
}
