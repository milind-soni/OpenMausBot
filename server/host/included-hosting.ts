// The client of the plan's included app hosting: a Cloud home asks the Admin's relay to publish a bot's site on
// MausBot's hosting account, a number of apps per plan, so the person needs no hosting account of their own.
//
// Security: the relay token is read from the server's held credential for each call and goes only to the relay address
// the Admin gave this home. It is never in what these functions return or throw, in a record, or in a log line. What the
// relay says is read as data: a refusal becomes this module's own sentence, with only the relay's numbers in it.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

import type { ServiceCredential } from "../included-services.ts";

export type HostedAppState = "creating" | "uploading" | "processing" | "ready" | "failed" | "taken_down";

export interface HostedApp {
  key: string;
  title: string;
  url: string | null;
  state: HostedAppState;
  /** Absent where every published app is public. */
  visibility?: "private" | "public";
  createdAt: number | null;
  publishedAt: number | null;
}

export interface HostingAllowance {
  apps: { used: number; max: number };
  publishes: { used: number; max: number; resetsAt: number | null };
  limits: { maxBytes: number; maxFileBytes: number; maxFiles: number };
}

export const DEFAULT_HOSTING_LIMITS = { maxBytes: 25 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxFiles: 500 } as const;

export type HostingRefusalCode =
  | "unavailable" | "not_included" | "plan_ended" | "apps_limit_reached" | "publishes_limit_reached" | "too_large" | "invalid_files"
  | "needs_own_netlify" | "taken_down" | "busy" | "in_progress" | "not_found" | "failed";

/** Why included hosting did not do something, in words for the bot to pass on. `ownNetlify`: the person's own Netlify
 * account can still do it. */
export class HostingRefusal extends Error {
  readonly code: HostingRefusalCode;
  readonly ownNetlify: boolean;
  constructor(code: HostingRefusalCode, message: string, ownNetlify = false) {
    super(message);
    this.code = code;
    this.ownNetlify = ownNetlify;
  }
}

export const OWN_NETLIFY = "Tell the person, and offer to publish on their own Netlify account instead (deploy.mjs in the publish-to-netlify skill).";
export const megabytes = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
const time = (value: unknown) => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const day = (at: number | null) => (at === null ? "the 1st of next month" : new Date(at).toISOString().slice(0, 10));
const shownPath = (value: unknown) => (typeof value === "string" ? JSON.stringify(value.replace(/\p{Cc}/gu, "").slice(0, 200)) : "A file");

const STATES: ReadonlySet<string> = new Set(["creating", "uploading", "processing", "ready", "failed", "taken_down"]);
const appSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  title: z.string().max(400).optional().catch(undefined),
  url: z.string().max(2_000).nullable().optional().catch(undefined),
  state: z.string().max(40).optional().catch(undefined),
  visibility: z.string().max(40).optional().catch(undefined),
  createdAt: z.unknown().optional(), publishedAt: z.unknown().optional(),
});
const pair = z.object({ used: z.unknown().optional(), max: z.unknown().optional() }).optional().catch(undefined);
const allowanceSchema = z.object({
  apps: pair,
  publishes: z.object({ used: z.unknown().optional(), max: z.unknown().optional(), resetsAt: z.unknown().optional() }).optional().catch(undefined),
  limits: z.object({ maxBytes: z.unknown().optional(), maxFileBytes: z.unknown().optional(), maxFiles: z.unknown().optional() }).optional().catch(undefined),
}).optional().catch(undefined);

/** Security: an app's address is shown, opened and framed, so only a plain https one counts (or one on the loopback
 * stand-in the relay itself is, in tests and fixtures). */
function appAddress(value: string | null | undefined, standIn: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  return url.protocol === "https:" || (standIn !== null && url.origin === standIn) ? url.href : null;
}

function readApp(value: unknown, standIn: string | null): HostedApp | null {
  const parsed = appSchema.safeParse(value);
  if (!parsed.success) return null;
  const app = parsed.data;
  return {
    key: app.key, title: (app.title ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, 200), url: appAddress(app.url, standIn),
    state: STATES.has(app.state ?? "") ? app.state as HostedAppState : "processing",
    ...(app.visibility === "private" || app.visibility === "public" ? { visibility: app.visibility } : {}),
    createdAt: time(app.createdAt), publishedAt: time(app.publishedAt),
  };
}

function readAllowance(value: unknown): HostingAllowance {
  const parsed = allowanceSchema.safeParse(value).data;
  const limit = (given: unknown, fallback: number) => { const n = count(given); return n !== null && n > 0 ? n : fallback; };
  return {
    apps: { used: count(parsed?.apps?.used) ?? 0, max: count(parsed?.apps?.max) ?? 0 },
    publishes: { used: count(parsed?.publishes?.used) ?? 0, max: count(parsed?.publishes?.max) ?? 0, resetsAt: time(parsed?.publishes?.resetsAt) },
    limits: {
      maxBytes: limit(parsed?.limits?.maxBytes, DEFAULT_HOSTING_LIMITS.maxBytes), maxFileBytes: limit(parsed?.limits?.maxFileBytes, DEFAULT_HOSTING_LIMITS.maxFileBytes),
      maxFiles: limit(parsed?.limits?.maxFiles, DEFAULT_HOSTING_LIMITS.maxFiles),
    },
  };
}

/** The relay's refusal in this app's words. 401 and 5xx are never the person's to fix. */
export function hostingRefusal(status: number, body: Record<string, unknown>): HostingRefusal {
  const code = typeof body.error === "string" ? body.error : "";
  const apps = (body.apps ?? {}) as { used?: unknown; max?: unknown }, publishes = (body.publishes ?? {}) as { max?: unknown; resetsAt?: unknown };
  switch (code) {
    case "apps_limit_reached": {
      const used = count(apps.used), max = count(apps.max);
      const numbers = used !== null && max !== null ? `${used} of ${max} apps are in use` : "every app the plan includes is in use";
      return new HostingRefusal("apps_limit_reached", `The plan's included hosting is full: ${numbers}. The person can delete one on the Published apps page to make room. ${OWN_NETLIFY}`, true);
    }
    case "publishes_limit_reached": {
      const max = count(publishes.max);
      return new HostingRefusal("publishes_limit_reached",
        `This month's included publishes are used up${max !== null ? ` (${max} of ${max})` : ""}; they start again on ${day(time(publishes.resetsAt))}. What is already published stays online. ${OWN_NETLIFY}`, true);
    }
    case "not_included":
      return new HostingRefusal("not_included", `This Cloud's plan doesn't include app hosting yet (a free trial gets it with its first payment). ${OWN_NETLIFY}`, true);
    case "subscription_inactive":
      return new HostingRefusal("plan_ended", `This Cloud's plan has ended, so its included hosting is off. ${OWN_NETLIFY}`, true);
    case "too_many_files": {
      const files = count(body.files), max = count(body.max);
      return new HostingRefusal("too_large", `The app has ${files ?? "too many"} files; included hosting takes at most ${max ?? DEFAULT_HOSTING_LIMITS.maxFiles}. Publish a smaller folder. ${OWN_NETLIFY}`, true);
    }
    case "file_too_large": {
      const size = count(body.size), max = count(body.max);
      return new HostingRefusal("too_large", `${shownPath(body.path)} is ${size !== null ? megabytes(size) : "too large"}; included hosting takes files up to ${megabytes(max ?? DEFAULT_HOSTING_LIMITS.maxFileBytes)}. ${OWN_NETLIFY}`, true);
    }
    case "app_too_large": case "request_too_large": {
      const bytes = count(body.bytes), max = count(body.max);
      return new HostingRefusal("too_large", `The app is ${bytes !== null ? megabytes(bytes) : "too large"}; included hosting takes apps up to ${megabytes(max ?? DEFAULT_HOSTING_LIMITS.maxBytes)}. ${OWN_NETLIFY}`, true);
    }
    case "invalid_files":
      return new HostingRefusal("invalid_files", `Included hosting can't publish ${shownPath(body.path)}: it takes plain static files with an index.html at the top. Fix or leave that file out, then publish again.`);
    case "app_taken_down":
      return new HostingRefusal("taken_down", "This app was taken down by MausBot, so it can't be published again. Tell the person; they can delete it on the Published apps page, and MausBot support can say why.");
    case "change_in_progress":
      return new HostingRefusal("in_progress", "Another change to this app is still running. Wait a minute, then check it with check_app_hosting.");
    case "busy":
      return new HostingRefusal("busy", "Included hosting is busy right now. Try again in a few minutes.");
    case "app_not_found": case "not_found":
      return new HostingRefusal("not_found", "Nothing is published from this folder on the plan's included hosting.");
    case "not_required": case "size_mismatch": case "digest_mismatch":
      return new HostingRefusal("failed", "A file changed while it was being published. Publish again.");
    default:
      return status === 401 || status === 402 || status >= 500 || status === 0
        ? new HostingRefusal("unavailable", `Included hosting isn't available right now. It is not something the person can fix; try again in a few minutes. ${OWN_NETLIFY}`, true)
        : new HostingRefusal("failed", "Included hosting could not do that. Try again.");
  }
}

export interface PublishFile { path: string; sha1: string; size: number }

export interface IncludedHostingDeps {
  /** The relay's address and this home's token, or null where the Admin gave none. */
  credential: () => ServiceCredential | null;
  fetch?: typeof fetch;
  /** The data folder: an app's key names its project folder by its place under it. */
  dataDir: string;
  warn?: (line: string) => void;
}

const CALL_TIMEOUT_MS = 30_000, UPLOAD_TIMEOUT_MS = 120_000;

export function createIncludedHosting(deps: IncludedHostingDeps) {
  const call = deps.fetch ?? fetch;
  const standIn = (): string | null => {
    const api = deps.credential()?.api;
    return api?.startsWith("http://") ? new URL(api).origin : null;
  };

  async function relay(method: string, path: string, init: { json?: unknown; bytes?: Buffer; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const credential = deps.credential();
    if (!credential) throw new HostingRefusal("unavailable", "This server has no included app hosting. Publish on the person's own Netlify account (deploy.mjs in the publish-to-netlify skill).", true);
    const timeout = AbortSignal.timeout(init.bytes ? UPLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS);
    let status = 0, body: Record<string, unknown> = {};
    try {
      const response = await call(`${credential.api}${path}`, {
        method, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${credential.token}`, accept: "application/json",
          ...(init.json !== undefined ? { "content-type": "application/json" } : init.bytes ? { "content-type": "application/octet-stream" } : {}) },
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.bytes ? { body: new Uint8Array(init.bytes) } : {}),
      });
      status = response.status;
      const parsed: unknown = await response.json().catch(() => null);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      if (init.signal?.aborted) throw new HostingRefusal("failed", "The publish was stopped.");
      throw hostingRefusal(0, {});
    }
    if (status >= 200 && status < 300) return body;
    if (status === 401) deps.warn?.("included app hosting: the relay refused this home's token; the Admin has to re-issue it");
    throw hostingRefusal(status, body);
  }

  const app = (value: unknown) => {
    const read = readApp(value, standIn());
    if (!read) throw new HostingRefusal("failed", "Included hosting gave an answer that could not be read. Try again.");
    return read;
  };
  const at = (key: string) => `/apps/${encodeURIComponent(key)}`;

  return {
    available: () => deps.credential() !== null,

    /** Security: an app's key is the bot and the project folder it is published from, so a record a bot wrote anywhere
     * can only ever name the app of the folder it sits in, never another bot's or another folder's. */
    async keyFor(botId: string, projectFolder: string): Promise<string> {
      const [folder, data] = await Promise.all([realpath(projectFolder), realpath(deps.dataDir).catch(() => deps.dataDir)]);
      const inside = relative(data, folder);
      const place = inside && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside) ? inside.split(sep).join("/") : folder;
      return `app-${createHash("sha256").update(`${botId}\n${place}`).digest("hex").slice(0, 32)}`;
    },

    async list(signal?: AbortSignal): Promise<{ apps: HostedApp[]; allowance: HostingAllowance }> {
      const body = await relay("GET", "/apps", signal ? { signal } : {});
      const apps = Array.isArray(body.apps) ? body.apps.flatMap((one) => readApp(one, standIn()) ?? []) : [];
      return { apps, allowance: readAllowance(body.allowance) };
    },

    async start(key: string, manifest: { title: string; files: PublishFile[] }, signal?: AbortSignal): Promise<{ app: HostedApp; created: boolean; required: string[]; allowance: HostingAllowance }> {
      const body = await relay("PUT", at(key), { json: manifest, ...(signal ? { signal } : {}) });
      const required = Array.isArray(body.required) ? body.required.flatMap((one) => { const sha1 = (one as { sha1?: unknown } | null)?.sha1; return typeof sha1 === "string" ? [sha1] : []; }) : [];
      return { app: app(body.app), created: body.created === true, required: [...new Set(required)], allowance: readAllowance(body.allowance) };
    },

    async upload(key: string, sha1: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
      await relay("PUT", `${at(key)}/files/${sha1}`, { bytes, ...(signal ? { signal } : {}) });
    },

    async app(key: string, signal?: AbortSignal): Promise<HostedApp> {
      return app((await relay("GET", at(key), signal ? { signal } : {})).app);
    },

    /** Opens an app that says it is private. A relay where every app is public has no such call: null. */
    async makePublic(key: string, signal?: AbortSignal): Promise<HostedApp | null> {
      try {
        return app((await relay("PATCH", at(key), { json: { visibility: "public" }, ...(signal ? { signal } : {}) })).app);
      } catch (error) {
        if (error instanceof HostingRefusal && (error.code === "not_found" || error.code === "failed")) return null;
        throw error;
      }
    },

    /** An app the relay no longer has counts as deleted. */
    async remove(key: string): Promise<void> {
      try {
        await relay("DELETE", at(key));
      } catch (error) {
        if (!(error instanceof HostingRefusal && error.code === "not_found")) throw error;
      }
    },
  };
}

export type IncludedHosting = ReturnType<typeof createIncludedHosting>;
