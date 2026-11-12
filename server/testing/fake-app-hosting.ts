#!/usr/bin/env node
// A stand-in on loopback for the Admin's included app hosting relay (Cloud's docs/consumer-cloud.md, "Included app
// hosting"): the list with the plan's allowance, a file-digest publish, file uploads, the publish's state, deleting an
// app, an operator's takedown, and the published app itself under /live/<site>/.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export const FAKE_HOSTING_PATH = "/api/cloud/services/hosting/v1";

interface FakeApp {
  key: string;
  title: string;
  site: string;
  state: "uploading" | "processing" | "ready" | "failed";
  visibility: "private" | "public";
  takenDown: boolean;
  files: Record<string, string>;
  pending: Map<string, { path: string; size: number }>;
  pollsLeft: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  live: Map<string, Buffer>;
}

export interface FakeAppHosting {
  /** What a home gets as OMB_CLOUD_HOSTING_URL. */
  url: string;
  origin: string;
  /** Every request to the relay, in order: "METHOD /path" after the relay's base. */
  requests: string[];
  /** Authorization headers that were not the expected token. */
  refused: string[];
  apps: Map<string, FakeApp>;
  /** Paths whose bytes were uploaded, in order. */
  uploads: string[];
  plan: { apps: number; publishes: number; publishesUsed: number };
  limits: { maxBytes: number; maxFileBytes: number; maxFiles: number };
  /** The next relay request answers this instead. */
  failNext(status: number, body: unknown): void;
  /** How many state reads a publish answers "processing" before it is ready. */
  processingPolls: number;
  /** What an app's root is served as. */
  rootContentType: string;
  /** An operator's takedown: the app's address stops answering and its key can't be published again. */
  takeDown(key: string): void;
  liveUrl(key: string): string;
  stop(): Promise<void>;
}

/** Must match the relay's `appPathProblem` (Cloud's server/cloud-app-hosting.ts). */
function pathProblem(path: string): boolean {
  if (!path || path.length > 512 || /[\p{Cc}\\#?]/u.test(path) || path.startsWith("/")) return true;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || (part.startsWith(".") && part !== ".well-known"))) return true;
  const top = parts[0]!.toLowerCase();
  return (parts.length === 1 && (top === "_redirects" || top === "netlify.toml")) || top === "netlify";
}

/** `privateFirst`: a new app is private until `PATCH { visibility: "public" }`, and every app says its `visibility`.
 * Without it an app is public as soon as it is ready, says no visibility and has no PATCH. */
export async function startFakeAppHosting(token: string, options: { apps?: number; publishes?: number; privateFirst?: boolean } = {}): Promise<FakeAppHosting> {
  const blobs = new Map<string, Buffer>();
  let failure: { status: number; body: unknown } | null = null;
  const fake: Omit<FakeAppHosting, "url" | "origin" | "stop" | "liveUrl" | "takeDown"> = {
    requests: [], refused: [], apps: new Map(), uploads: [],
    plan: { apps: options.apps ?? 10, publishes: options.publishes ?? 200, publishesUsed: 0 },
    limits: { maxBytes: 25 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxFiles: 500 },
    failNext: (status, body) => { failure = { status, body }; },
    processingPolls: 0,
    rootContentType: "text/html; charset=UTF-8",
  };
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
  const view = (app: FakeApp) => ({
    key: app.key, title: app.title, url: `${origin()}/live/${app.site}/`, state: app.takenDown ? "taken_down" : app.state,
    ...(options.privateFirst ? { visibility: app.visibility } : {}),
    createdAt: iso(app.createdAt), updatedAt: iso(app.updatedAt), publishedAt: iso(app.publishedAt),
  });
  const allowance = () => ({
    apps: { used: fake.apps.size, max: fake.plan.apps },
    publishes: { used: Math.min(fake.plan.publishesUsed, fake.plan.publishes), max: fake.plan.publishes, resetsAt: "2026-12-01T00:00:00.000Z" },
    limits: fake.limits,
  });
  const settle = (app: FakeApp) => {
    if (app.pending.size) return;
    if (app.pollsLeft > 0) { app.state = "processing"; return; }
    app.state = "ready";
    app.publishedAt = Date.now();
    app.live = new Map(Object.entries(app.files).map(([path, sha]) => [path, blobs.get(sha)!]));
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = decodeURIComponent(new URL(req.url ?? "/", origin()).pathname);
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      };
      const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => send(status, { error, message, ...extra });

      const page = /^\/live\/([\w-]+)(\/.*)?$/.exec(path);
      if (page) {
        const app = [...fake.apps.values()].find((one) => one.site === page[1]);
        const file = page[2] === undefined || page[2] === "/" ? "index.html" : page[2].slice(1);
        if (!app || app.takenDown) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
        if (app.visibility === "private") { res.writeHead(401, { "content-type": "text/html" }); return res.end("<title>Login Redirect</title>"); }
        const bytes = app.live.get(file);
        const type = file === "index.html" ? fake.rootContentType : file.endsWith(".html") ? "text/html; charset=UTF-8" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
        res.writeHead(bytes ? 200 : 404, { "content-type": bytes ? type : "text/plain" });
        return res.end(bytes ?? "Not found");
      }
      if (!path.startsWith(`${FAKE_HOSTING_PATH}/`)) return refuse(404, "not_found", "Not found.");
      const rest = path.slice(FAKE_HOSTING_PATH.length);
      fake.requests.push(`${req.method} ${rest}`);
      if (req.headers.authorization !== `Bearer ${token}`) {
        fake.refused.push(req.headers.authorization ?? "");
        return refuse(401, "invalid_api_key", "This app hosting token is not valid.");
      }
      if (failure) {
        const { status, body: answer } = failure;
        failure = null;
        return send(status, answer);
      }

      if (rest === "/apps" && req.method === "GET") {
        return send(200, { apps: [...fake.apps.values()].sort((a, b) => b.createdAt - a.createdAt).map(view), allowance: allowance() });
      }
      const fileRoute = /^\/apps\/([^/]+)\/files\/([0-9a-f]{40})$/.exec(rest);
      const appRoute = fileRoute ? null : /^\/apps\/([^/]+)$/.exec(rest);
      const key = (fileRoute ?? appRoute)?.[1];
      if (!key) return refuse(404, "not_found", "Not found.");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) return refuse(400, "invalid_app_key", "Name the app by a key of letters, digits, dots, dashes or underscores, at most 64.");
      const app = fake.apps.get(key);

      if (fileRoute && req.method === "PUT") {
        if (!app) return refuse(404, "app_not_found", "There is no such published app on this Cloud.");
        const wanted = app.state === "uploading" ? app.pending.get(fileRoute[2]!) : undefined;
        if (!wanted) return refuse(409, "not_required", "This file isn't needed for the app's current publish.");
        if (body.byteLength !== wanted.size) return refuse(400, "size_mismatch", "The file isn't the size its publish declared.", { path: wanted.path });
        if (createHash("sha1").update(body).digest("hex") !== fileRoute[2]) return refuse(400, "digest_mismatch", "The file doesn't match the SHA1 its publish declared.", { path: wanted.path });
        blobs.set(fileRoute[2]!, body);
        fake.uploads.push(wanted.path);
        app.pending.delete(fileRoute[2]!);
        settle(app);
        return send(200, { uploaded: true, remaining: app.pending.size, state: app.pending.size ? "uploading" : "processing" });
      }
      if (!appRoute) return refuse(404, "not_found", "Not found.");

      if (req.method === "GET") {
        if (!app) return refuse(404, "app_not_found", "There is no such published app on this Cloud.");
        if (app.state === "processing") { app.pollsLeft -= 1; settle(app); }
        return send(200, { app: view(app) });
      }
      if (req.method === "DELETE") {
        if (!app) return refuse(404, "app_not_found", "There is no such published app on this Cloud.");
        fake.apps.delete(key);
        return send(200, { deleted: true, allowance: allowance() });
      }
      if (req.method === "PATCH" && options.privateFirst) {
        if (!app) return refuse(404, "app_not_found", "There is no such published app on this Cloud.");
        const visibility = (JSON.parse(body.toString() || "{}") as { visibility?: string }).visibility;
        if (visibility !== "public" && visibility !== "private") return refuse(400, "invalid_request", "Send visibility as private or public.");
        app.visibility = visibility;
        return send(200, { app: view(app) });
      }
      if (req.method !== "PUT") return refuse(404, "not_found", "Not found.");

      let manifest: { title?: unknown; files?: unknown };
      try { manifest = JSON.parse(body.toString()) as typeof manifest; } catch { return refuse(400, "invalid_json", "Send a JSON object."); }
      const files = Array.isArray(manifest.files) ? manifest.files as Array<{ path: string; sha1: string; size: number }> : [];
      if (typeof manifest.title !== "string" || !manifest.title.trim() || !files.length || Object.keys(manifest).some((name) => name !== "title" && name !== "files")) {
        return refuse(400, "invalid_request", "Send a title (up to 120 characters, one line) and files, each with its path, sha1 and size.");
      }
      const { limits, plan } = fake;
      if (files.length > limits.maxFiles) return refuse(413, "too_many_files", `An app can have at most ${limits.maxFiles} files.`, { files: files.length, max: limits.maxFiles });
      const seen = new Set<string>();
      let bytes = 0;
      for (const file of files) {
        if (seen.has(file.path) || pathProblem(file.path)) return refuse(400, "invalid_files", `${JSON.stringify(file.path)} can't be published.`, { path: file.path });
        if (file.size > limits.maxFileBytes) return refuse(413, "file_too_large", `${JSON.stringify(file.path)} is larger than the most one file may be.`, { path: file.path, size: file.size, max: limits.maxFileBytes });
        seen.add(file.path);
        bytes += file.size;
      }
      if (bytes > limits.maxBytes) return refuse(413, "app_too_large", "The app's files are larger than the most one app may be.", { bytes, max: limits.maxBytes });
      if (!seen.has("index.html")) return refuse(400, "invalid_files", "The app needs an index.html at its top.", { path: "index.html" });
      if (plan.apps < 1) return refuse(402, "not_included", "Your Cloud plan doesn't include published apps.");
      if (app?.takenDown) return refuse(409, "app_taken_down", "This app was taken down and can't be published again.");
      const used = fake.apps.size;
      if (app ? used > plan.apps : used >= plan.apps) return refuse(429, "apps_limit_reached", "The plan's apps are all used.", { apps: { used, max: plan.apps } });
      if (plan.publishesUsed >= plan.publishes) {
        return refuse(429, "publishes_limit_reached", "The month's publishes are used up.", { publishes: { used: plan.publishes, max: plan.publishes, resetsAt: "2026-12-01T00:00:00.000Z" } });
      }
      plan.publishesUsed += 1;
      const now = Date.now();
      const next: FakeApp = app ?? {
        key, title: "", site: `mb-${randomBytes(8).toString("hex")}`, state: "uploading", visibility: options.privateFirst ? "private" : "public", takenDown: false,
        files: {}, pending: new Map(), pollsLeft: 0, createdAt: now, updatedAt: now, publishedAt: null, live: new Map(),
      };
      next.title = manifest.title.trim();
      next.files = Object.fromEntries(files.map((file) => [file.path, file.sha1]));
      next.pending = new Map(files.filter((file) => !blobs.has(file.sha1)).map((file) => [file.sha1, { path: file.path, size: file.size }]));
      next.state = "uploading";
      next.pollsLeft = fake.processingPolls;
      next.updatedAt = now;
      fake.apps.set(key, next);
      settle(next);
      return send(200, { app: view(next), created: !app, required: [...next.pending].map(([sha1, file]) => ({ path: file.path, sha1 })), allowance: allowance() });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return Object.assign(fake, {
    origin: origin(),
    url: `${origin()}${FAKE_HOSTING_PATH}`,
    liveUrl: (key: string) => `${origin()}/live/${fake.apps.get(key)?.site ?? "none"}/`,
    takeDown: (key: string) => { const app = fake.apps.get(key); if (app) app.takenDown = true; },
    stop: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.FAKE_APP_HOSTING_TOKEN;
  if (!token) throw new Error("set FAKE_APP_HOSTING_TOKEN to the token the stand-in accepts");
  console.log((await startFakeAppHosting(token)).url);
}
