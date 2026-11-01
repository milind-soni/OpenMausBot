// GET /api/workspace/banner serves this workspace's banner picture to anyone signed in here (a member included);
// PUT (the picture's bytes) and DELETE change it, for whoever may change this workspace's settings (an admin
// session: on a team's Cloud its Super admin and Admins; request-auth.ts keeps both admin-only). Nobody unpaired
// or signed out reaches any of them: the auth gate runs first. The picture is kept with the workspace's other
// images (the attachments folder), and which one is the banner in workspace-banner.json beside them.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { basename, join } from "node:path";

import { ATTACHMENTS_DIR, deleteAttachment, readAttachment, saveImage } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import { BANNER_MAX_BYTES, BANNER_NAME, BANNER_REFUSALS, bannerRecord, checkBanner, type BannerRefusal, type StoredBanner } from "../workspace-banner.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const BANNER_PATH = "/api/workspace/banner";

/** What a page learns of it: a version that changes with the picture, never its file's name. */
export interface BannerSummary { version: string; width: number; height: number }

export const bannerVersion = (name: string): string => createHash("sha256").update(name).digest("base64url").slice(0, 16);
export const bannerSummary = (banner: StoredBanner | null): BannerSummary | null =>
  banner ? { version: bannerVersion(banner.name), width: banner.width, height: banner.height } : null;

/** Where the banner is kept: which attachment it is, and the attachments themselves. */
export interface BannerStore {
  current(): StoredBanner | null;
  set(next: StoredBanner | null): void;
  save(bytes: Buffer, mime: string): { name: string };
  read(name: string): { bytes: Buffer; mime: string } | null;
  remove(name: string): void;
}

const record = bannerRecord(join(DATA_DIR, "workspace-banner.json"));
/** This workspace's own: workspace-banner.json beside its attachments, which keep the picture as they keep bots' avatars. */
export const workspaceBannerStore: BannerStore = {
  current: () => record.current(),
  set: (next) => record.set(next),
  save: (bytes, mime) => ({ name: basename(saveImage(bytes, mime).path) }),
  read: (name) => readAttachment(name),
  remove: (name) => { if (BANNER_NAME.test(name)) deleteAttachment(join(ATTACHMENTS_DIR, name)); },
};
/** For GET /api/config: this workspace's banner as a page may know it. */
export const workspaceBannerSummary = (): BannerSummary | null => bannerSummary(workspaceBannerStore.current());

const STATUS: Readonly<Record<BannerRefusal, number>> = { format: 415, size: 413, dimensions: 422, animated: 422, damaged: 422 };

/** The request's bytes, or null as soon as they pass `limit`: the answer goes then, and the rest is discarded unread. */
function bodyBytes(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) { chunks.push(chunk); return; }
      req.off("data", onData);
      chunks.length = 0;
      req.resume();
      resolve(null);
    };
    req.on("data", onData);
    req.once("end", () => resolve(size <= limit ? Buffer.concat(chunks) : null));
    req.once("error", reject);
  });
}

/** `changed()`: tell every open page (a config frame), after the banner changed. */
export function createWorkspaceBannerRoutes({ changed, store = workspaceBannerStore }: { changed(): void; store?: BannerStore }): RouteHandler {
  const deps = { ...store, set: (next: StoredBanner | null) => { store.set(next); changed(); } };
  return async ({ req, res, method, path, json }) => {
    if (path !== BANNER_PATH) return PASS;
    if (method === "GET") {
      const banner = deps.current(), stored = banner ? deps.read(banner.name) : null;
      if (!banner || !stored) return json(res, 404, { error: "This workspace has no banner picture." });
      const etag = `"${bannerVersion(banner.name)}"`;
      // Checked again on every use, so a session that ended never sees it from cache.
      const headers = { "content-type": stored.mime, "cache-control": "private, no-cache", etag, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" };
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, { ...headers, "content-length": String(stored.bytes.length) });
      res.end(stored.bytes);
      return;
    }
    if (method === "PUT") {
      const declared = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > BANNER_MAX_BYTES) { req.resume(); return json(res, 413, { error: BANNER_REFUSALS.size, refusal: "size" }); }
      const bytes = await bodyBytes(req, BANNER_MAX_BYTES);
      if (!bytes) return json(res, 413, { error: BANNER_REFUSALS.size, refusal: "size" });
      const checked = checkBanner(bytes);
      if (!checked.ok) return json(res, STATUS[checked.refusal], { error: BANNER_REFUSALS[checked.refusal], refusal: checked.refusal });
      const before = deps.current();
      const saved = deps.save(checked.bytes, checked.mime);
      const next = { name: saved.name, width: checked.width, height: checked.height };
      deps.set(next);
      if (before && before.name !== next.name) deps.remove(before.name);
      return json(res, 200, { banner: bannerSummary(next) });
    }
    if (method === "DELETE") {
      const before = deps.current();
      deps.set(null);
      if (before) deps.remove(before.name);
      return json(res, 200, { banner: null });
    }
    return json(res, 405, { error: "Use GET, PUT or DELETE." });
  };
}
