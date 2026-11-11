// Publishes a folder a bot built to the plan's included app hosting, for the bot's publish_app tool: the server reads
// the folder, sends it through the relay, waits for it to be live and leaves the record the Published apps page lists.
//
// Security: the bot names a path and nothing else. The folder must be inside the bot's own folders for this turn
// (resolved, so `..` and links out land outside and are refused); files are read without following links and each one is
// re-checked to be inside the folder when it is opened; dotfiles, env files, keys and node_modules never go. The relay
// token stays in included-hosting.ts: nothing here sees it, so no answer or record can carry it.
import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalRoots, containedBy, readContained } from "../pages/bundle.ts";
import { inSecretFolder, SECRET_FILE_REFUSAL } from "../secret-folder.ts";
import { HostingRefusal, megabytes, OWN_NETLIFY, type HostedApp, type HostingAllowance, type IncludedHosting } from "./included-hosting.ts";
import { findNetlifySites, readSite, SITE_FILE } from "./netlify-sites.ts";

/** Must match `SECRET_NAMES`, `SKIPPED_FOLDERS` and `SKIPPED_FILES` in skills/publish-to-netlify/deploy.mjs. */
const SECRET_NAMES = [
  /^env(\.(local|development|production|staging|test))?$/i,
  /\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(credentials|secrets?|service-account)(\..+)?\.(json|ya?ml|toml|txt)$/i,
  /^(npmrc|netrc|htpasswd)$/i,
];
const SKIPPED_FOLDERS = new Set(["node_modules", "__MACOSX"]);
const SKIPPED_FILES = new Set(["Thumbs.db"]);

/** Whether a file at this path, relative to the published folder, may be published. Must match `publishable` in
 * skills/publish-to-netlify/deploy.mjs. */
export function publishable(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  const name = parts.at(-1)!;
  for (const part of parts) {
    if (part.startsWith(".") && part !== ".well-known") return false;
    if (SKIPPED_FOLDERS.has(part)) return false;
  }
  if (SKIPPED_FILES.has(name)) return false;
  if (/[#?]/.test(path)) return false;
  return !SECRET_NAMES.some((pattern) => pattern.test(name));
}

/** What included hosting leaves to the person's own Netlify account: anything that configures Netlify or runs there. */
export function needsOwnNetlify(path: string): string | null {
  const parts = path.split("/"), top = parts[0]!.toLowerCase();
  if (parts.length === 1 && top === "_redirects") return "redirects (a _redirects file)";
  if (parts.length === 1 && top === "netlify.toml") return "Netlify settings (a netlify.toml file)";
  if (top === "netlify") return "functions, a database or a server (a netlify folder)";
  return null;
}

export interface AppFile { path: string; data: Buffer; sha1: string }
const MAX_DEPTH = 24;

/** Every publishable plain file under `folder`, with the ones left out. Paths are relative to it, with `/` between parts. */
export async function collectAppFiles(folder: string, limits: HostingAllowance["limits"]): Promise<{ files: AppFile[]; bytes: number; skipped: string[] }> {
  // Each file is checked to be inside this folder by its resolved path, so the folder is compared in the same form.
  const dir = await realpath(folder);
  const files: AppFile[] = [], skipped: string[] = [];
  let listed = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      const full = join(folder, name), path = relative(dir, full).split(sep).join("/");
      const info = await lstat(full);
      const needs = needsOwnNetlify(path);
      if (needs && !info.isSymbolicLink()) throw new HostingRefusal("needs_own_netlify", `This app uses ${needs}, which included hosting doesn't do: it publishes plain static files only. ${OWN_NETLIFY}`, true);
      if (info.isSymbolicLink() || !publishable(path) || /[\p{Cc}\\]/u.test(name) || path.length > 512 || inSecretFolder(full)) { skipped.push(path); continue; }
      if (info.isDirectory()) {
        if (depth >= MAX_DEPTH) { skipped.push(`${path}/`); continue; }
        await walk(full, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > limits.maxFileBytes) {
        throw new HostingRefusal("too_large", `${JSON.stringify(path)} is ${megabytes(info.size)}; included hosting takes files up to ${megabytes(limits.maxFileBytes)}. ${OWN_NETLIFY}`, true);
      }
      if (files.length >= limits.maxFiles) throw new HostingRefusal("too_large", `The folder has more than ${limits.maxFiles} files, the most included hosting takes. Publish a smaller folder. ${OWN_NETLIFY}`, true);
      listed += info.size;
      if (listed > limits.maxBytes) throw new HostingRefusal("too_large", `The folder is larger than ${megabytes(limits.maxBytes)}, the most included hosting takes. ${OWN_NETLIFY}`, true);
      const data = await readContained(full, dir).catch(() => null);
      if (!data) { skipped.push(path); continue; }
      files.push({ path, data, sha1: createHash("sha1").update(data).digest("hex") });
    }
  };
  await walk(dir, 0);
  return { files, bytes: files.reduce((sum, file) => sum + file.data.byteLength, 0), skipped };
}

const oneLine = (value: string, max: number) => value.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, max);
const iso = (at: number) => new Date(at).toISOString();
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The folder at `requested` (absolute, or relative to one of the bot's folders), canonical, inside those folders. */
async function locateFolder(requested: string, roots: readonly string[], what: string): Promise<string> {
  const trimmed = requested.trim();
  if (!trimmed) throw new HostingRefusal("failed", `${what} is required: a folder in your working folder.`);
  const allowed = await canonicalRoots(roots);
  const candidates = isAbsolute(trimmed) ? [resolve(trimmed)] : allowed.map((root) => resolve(root, trimmed));
  let outside = false;
  for (const candidate of candidates) {
    const target = await realpath(candidate).catch(() => null);
    if (!target) continue;
    if (!allowed.some((root) => containedBy(root, target))) { outside = true; continue; }
    if (inSecretFolder(target)) throw new HostingRefusal("failed", SECRET_FILE_REFUSAL);
    if (!(await stat(target)).isDirectory()) throw new HostingRefusal("failed", `${trimmed} is a file. Publish the folder that holds the app's index.html.`);
    return target;
  }
  if (outside) throw new HostingRefusal("failed", "Only a folder inside your own working folder can be published. Build the app there first.");
  throw new HostingRefusal("failed", `No folder was found at ${trimmed}. Pass the exact path of the folder to publish.`);
}

export interface AppPublisherDeps {
  hosting: IncludedHosting;
  botName: (botId: string) => string;
  /** The folder every conversation with this bot reaches: where a project lives so a later conversation finds it. */
  botFolder: (botId: string) => string;
  /** The person's home folder: a bot folder that holds all of it is never searched for records. */
  home: string;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  /** How often the publish's state is read, how long a publish is waited for, and how long its link. */
  pollMs?: number; waitMs?: number; linkWaitMs?: number;
}

export interface AppPublishInput {
  botId: string;
  /** The bot's own folders for this turn. */
  roots: readonly string[];
  /** The folder to publish. */
  path: string;
  /** The project's folder, which keeps the record; the published folder itself when absent. */
  project?: string;
  title?: string;
}

export type AppPublishAnswer = { status: 200 | 400 | 403 | 409 | 502; body: Record<string, unknown> };

const UPLOADS_AT_ONCE = 4, UPLOAD_TRIES = 3;
const said = (allowance: HostingAllowance) => ({
  apps: `${allowance.apps.used} of ${allowance.apps.max}`,
  publishesThisMonth: `${allowance.publishes.used} of ${allowance.publishes.max}`,
});

export function createAppPublisher(deps: AppPublisherDeps) {
  const { hosting } = deps, call = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 2_000, waitMs = deps.waitMs ?? 90_000, linkWaitMs = deps.linkWaitMs ?? 30_000;

  /** Whether the app's address answers as a web page. Opening a private app takes a few seconds to show, so a login
   * answer is waited through. */
  async function checkLink(url: string): Promise<{ live: boolean; liveStatus: number; contentType?: string }> {
    const started = now();
    for (;;) {
      const seen = await call(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).then(async (response) => {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, type: response.headers.get("content-type") ?? "" };
      }, () => ({ status: 0, type: "" }));
      if (seen.status === 200) return { live: /^text\/html\b/i.test(seen.type), liveStatus: 200, contentType: seen.type };
      if (now() - started >= linkWaitMs) return { live: false, liveStatus: seen.status };
      await wait(Math.min(pollMs, 2_000));
    }
  }

  async function writeRecord(project: string, record: Record<string, unknown>): Promise<void> {
    // Written beside and renamed over: a record a bot swapped for a link is replaced, never written through.
    if (await realpath(project).catch(() => null) !== project) return;
    const temp = join(project, `${SITE_FILE}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o644 });
      await rename(temp, join(project, SITE_FILE));
    } catch {
      await unlink(temp).catch(() => {});
    }
  }

  async function forgetRecord(project: string): Promise<void> {
    const file = join(project, SITE_FILE);
    if ((await readSite(file, deps.env))?.hosting === "included") await unlink(file).catch(() => {});
  }

  /** The turn's folders with the bot's shared one first, so a relative path names the same folder in every conversation. */
  function folders(input: Pick<AppPublishInput, "botId" | "roots">): string[] {
    const shared = resolve(deps.botFolder(input.botId));
    return [...input.roots.filter((root) => resolve(root) === shared), ...input.roots.filter((root) => resolve(root) !== shared)];
  }

  async function inSharedFolder(botId: string, folder: string): Promise<boolean> {
    const shared = await realpath(deps.botFolder(botId)).catch(() => null);
    return shared !== null && containedBy(shared, folder);
  }

  async function place(input: AppPublishInput): Promise<{ dir: string; project: string; key: string }> {
    const dir = await locateFolder(input.path, folders(input), "path");
    const project = input.project?.trim() ? await locateFolder(input.project, folders(input), "project") : dir;
    if (!containedBy(project, dir)) throw new HostingRefusal("failed", "path must be the project folder or a folder inside it (for example project \"shop\" and path \"shop/dist\").");
    return { dir, project, key: await hosting.keyFor(input.botId, project) };
  }

  const refused = (error: unknown): AppPublishAnswer => {
    if (!(error instanceof HostingRefusal)) throw error;
    const status = error.code === "unavailable" || error.code === "busy" ? 502 : error.code === "failed" || error.code === "invalid_files" ? 400 : 409;
    return { status, body: { error: error.message, code: error.code, ...(error.ownNetlify ? { offerOwnNetlify: true } : {}) } };
  };

  /** A ready app made public where the relay keeps new apps private, checked at its address, with its record brought up to date. */
  async function settle(app: HostedApp, project: string, input: AppPublishInput, existing: Awaited<ReturnType<typeof readSite>>, firstLook: boolean): Promise<Record<string, unknown>> {
    const base = {
      version: 1, hosting: "included", appKey: app.key, siteId: app.key, ...(app.url ? { url: app.url } : {}),
      title: app.title || oneLine(input.title ?? "", 120) || existing?.title || "App", botId: input.botId,
      ...(deps.botName(input.botId) ? { botName: oneLine(deps.botName(input.botId), 80) } : {}),
      createdAt: iso(app.createdAt ?? now()),
    };
    if (app.state !== "ready" || !app.url) {
      await writeRecord(project, { ...base, ...(app.publishedAt ? { publishedAt: iso(app.publishedAt) } : {}), deployState: app.state });
      return { url: app.url, state: app.state, live: false };
    }
    const opened = app.visibility === "private" ? await hosting.makePublic(app.key) ?? app : app;
    const link = await checkLink(opened.url ?? app.url);
    await writeRecord(project, {
      ...base, publishedAt: iso(firstLook ? now() : app.publishedAt ?? now()), deployState: "ready",
      ...(link.liveStatus === 200 ? { access: "public" } : link.liveStatus === 401 ? { access: "private" } : {}),
    });
    return { url: opened.url ?? app.url, state: "ready", ...link };
  }

  return {
    /** publish_app: publishes the folder, or the same app again, and answers once it is live or still being processed. */
    async publish(input: AppPublishInput, turn: { assertActive?: () => void; signal?: AbortSignal } = {}): Promise<AppPublishAnswer> {
      try {
        const title = oneLine(input.title ?? "", 120);
        if (!title) throw new HostingRefusal("failed", "title is required: what the app is, in a few words.");
        const { dir, project, key } = await place(input);
        const existing = await readSite(join(project, SITE_FILE), deps.env);
        if (existing && !existing.hosting) {
          throw new HostingRefusal("failed", `This project is already published on the person's own Netlify account (${existing.url}). Keep updating it there with deploy.mjs, so its link stays the same.`);
        }
        const before = await hosting.list(turn.signal);
        const { files, bytes, skipped } = await collectAppFiles(dir, before.allowance.limits);
        if (!files.some((file) => file.path === "index.html")) throw new HostingRefusal("failed", `${input.path.trim()} has no index.html at its top. Publish the built output folder.`);
        turn.assertActive?.();

        const started = await hosting.start(key, { title, files: files.map((file) => ({ path: file.path, sha1: file.sha1, size: file.data.byteLength })) }, turn.signal);
        const bySha = new Map(files.map((file) => [file.sha1, file]));
        const queue = started.required.flatMap((sha1) => bySha.get(sha1) ?? []);
        const upload = async (file: AppFile) => {
          for (let attempt = 1; ; attempt += 1) {
            try { return await hosting.upload(key, file.sha1, file.data, turn.signal); } catch (error) {
              if (!(error instanceof HostingRefusal) || (error.code !== "unavailable" && error.code !== "busy") || attempt === UPLOAD_TRIES || turn.signal?.aborted) throw error;
            }
            await wait(pollMs);
          }
        };
        await Promise.all(Array.from({ length: UPLOADS_AT_ONCE }, async () => {
          for (let file = queue.shift(); file; file = queue.shift()) await upload(file);
        }));

        let app = started.required.length ? await hosting.app(key, turn.signal) : started.app;
        const deadline = now() + waitMs;
        while (app.state !== "ready" && app.state !== "failed" && app.state !== "taken_down" && now() < deadline) {
          await wait(pollMs);
          turn.assertActive?.();
          app = await hosting.app(key, turn.signal);
        }
        const outcome = await settle(app, project, input, existing, true);
        const common = { created: started.created, files: files.length, uploaded: started.required.length, bytes, skipped, ...said(started.allowance) };
        if (app.state === "failed") {
          return { status: 502, body: { error: "Included hosting could not process this publish, so the app is not live (an earlier version stays up if there was one). Try once more; if it fails again, say so.", code: "failed", ...common } };
        }
        if (app.state !== "ready") {
          return { status: 200, body: { ok: true, ...outcome, pending: true, ...common, message: "The app was sent and is still being processed. It is not live yet and has not failed. Check it with check_app_hosting in a minute; don't publish again." } };
        }
        const tied = started.created && !await inSharedFolder(input.botId, project)
          ? { note: "This project is in this conversation's folder, so another conversation with you won't find it. Keep it here only if it is this person's alone on a team; otherwise build the next app under sites/ in your shared bot folder." } : {};
        const message = outcome.live ? "Published. The link is public: anyone who has it can open it."
          : outcome.liveStatus === 200 ? "The link answers, but not as a web page, so a browser would show the page's source. Don't call it published."
            : "The publish is ready, but the link did not answer as a page yet. Check it with check_app_hosting in a minute.";
        return { status: 200, body: { ok: true, ...outcome, ...common, message, ...tied } };
      } catch (error) {
        return refused(error);
      }
    },

    /** How much of the plan's hosting is used, and, with a folder, how its app is doing. */
    async status(input: Omit<AppPublishInput, "path"> & { path?: string }): Promise<AppPublishAnswer> {
      try {
        const { allowance } = await hosting.list();
        const included = { ...said(allowance), limits: `${megabytes(allowance.limits.maxBytes)} and ${allowance.limits.maxFiles} files an app, ${megabytes(allowance.limits.maxFileBytes)} a file` };
        const folder = input.project?.trim() || input.path?.trim();
        if (!folder) {
          const found = await findNetlifySites(folders(input), { home: deps.home, env: deps.env }).catch(() => []);
          const projects = found.map((site) => ({ title: site.title, folder: dirname(site.file), ...(site.url ? { url: site.url } : {}), on: site.hosting ? "included hosting" : "the person's own Netlify" }));
          return { status: 200, body: { ok: true, ...included, projects } };
        }
        const project = await locateFolder(folder, folders(input), "path");
        const key = await hosting.keyFor(input.botId, project);
        const app = await hosting.app(key);
        const existing = await readSite(join(project, SITE_FILE), deps.env);
        const outcome = await settle(app, project, { ...input, path: folder }, existing, false);
        return { status: 200, body: { ok: true, title: app.title, ...outcome, ...(app.state === "taken_down" ? { message: "This app was taken down by MausBot. Its link no longer works." } : {}), ...included } };
      } catch (error) {
        return refused(error);
      }
    },

    /** Deletes the app published from this folder: its link stops working and its place in the plan is free. */
    async remove(input: Omit<AppPublishInput, "title">): Promise<AppPublishAnswer> {
      try {
        const project = await locateFolder(input.project?.trim() || input.path, folders(input), "path");
        const key = await hosting.keyFor(input.botId, project);
        const app = await hosting.app(key).catch(async (error: unknown) => {
          if (error instanceof HostingRefusal && error.code === "not_found") await forgetRecord(project);
          throw error;
        });
        await hosting.remove(key);
        await forgetRecord(project);
        const { allowance } = await hosting.list().catch(() => ({ allowance: null }));
        return { status: 200, body: { ok: true, deleted: true, title: app.title, url: app.url, message: "The app was deleted and its link no longer works. Your files stay.", ...(allowance ? said(allowance) : {}) } };
      } catch (error) {
        return refused(error);
      }
    },

    /** The Published apps page's Delete. */
    async removeByKey(key: string, recordFile: string | null): Promise<void> {
      await hosting.remove(key);
      if (recordFile) await forgetRecord(dirname(resolve(recordFile)));
    },
  };
}

export type AppPublisher = ReturnType<typeof createAppPublisher>;
