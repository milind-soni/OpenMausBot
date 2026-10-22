// A person's own Composio project, reached with their ak_ key. A Tool Router Session uses one of the project's own auth
// configs (a bring-your-own OAuth app such as Xero or Buffer, or an API-key toolkit) only when it is created with that
// config's id under `auth_configs`, keyed by toolkit, and the config must be enabled for Tool Router:
// https://docs.composio.dev/docs/configuring-sessions
// https://docs.composio.dev/kb/guide/mcp-tool-router-sessions
// https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigs
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { AUTH_CONFIG_ID } from "../shared/connector-availability.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const DEFAULT_BACKEND_ORIGIN = "https://backend.composio.dev";

export function apiBase() {
  return (process.env.OMB_COMPOSIO_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3.1`).replace(/\/$/, "");
}

export function projectHeaders(apiKey: string, json = false) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

export async function responseError(res: Response, fallback: string) {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw);
    return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
  } catch {
    return raw.trim().slice(0, 300) || fallback;
  }
}

export function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Composio's slug is `twitter`; saved cards and model calls may still say `x`. */
export function canonicalToolkitSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  return normalized === "x" ? "twitter" : normalized;
}

export type AuthConfigMap = Record<string, string>;

const authConfigItemSchema = z.object({
  id: z.string().optional(),
  status: z.string().nullable().optional(),
  is_composio_managed: z.boolean().optional(),
  is_enabled_for_tool_router: z.boolean().nullable().optional(),
  last_updated_at: z.string().nullable().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
const authConfigsPageSchema = z.object({
  items: z.array(authConfigItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});
const MAX_AUTH_CONFIG_PAGES = 20;
const LISTING_TTL_MS = 60_000;
const LISTING_RETRY_MS = 15_000;

interface AuthConfigListing {
  /** Toolkit -> its enabled configs, most recently updated first. */
  byToolkit: Map<string, string[]>;
  /** Every usable config id with its toolkit, so a kept pick that was since deleted or disabled is dropped. */
  usable: Map<string, string>;
  offForToolRouter: Set<string>;
}

interface ListingEntry {
  listing: AuthConfigListing;
  expiresAt: number;
  readError?: string;
}

export interface ProjectAuthConfigs {
  /** Toolkit -> the auth config a Session names: the one a bot picked, else the most recently updated enabled one. */
  configs: AuthConfigMap;
  /** Toolkits whose enabled custom auth configs are all switched off for Tool Router. */
  offForToolRouter: string[];
  /** Why the project's configs could not be read just now; `configs` then comes from the last read that worked. */
  readError?: string;
}

function usableConfig(item: z.infer<typeof authConfigItemSchema>): boolean {
  return item.is_composio_managed !== true && (!item.status || /^enabled$/i.test(item.status));
}

async function readListing(apiKey: string): Promise<AuthConfigListing> {
  const found = new Map<string, Array<{ id: string; updated: string }>>();
  const usable = new Map<string, string>();
  const offForToolRouter = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTH_CONFIG_PAGES; page++) {
    const params = new URLSearchParams({ is_composio_managed: "false", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${apiBase()}/auth_configs?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(await responseError(res, `HTTP ${res.status}`));
    const body = authConfigsPageSchema.parse(await res.json());
    for (const item of body.items ?? []) {
      const slug = item.toolkit?.slug ? canonicalToolkitSlug(item.toolkit.slug) : "";
      if (!slug || !item.id || !usableConfig(item)) continue;
      if (item.is_enabled_for_tool_router === false) {
        offForToolRouter.add(slug);
        continue;
      }
      usable.set(item.id, slug);
      found.set(slug, [...found.get(slug) ?? [], { id: item.id, updated: item.last_updated_at ?? "" }]);
    }
    const next = body.next_cursor ?? undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  const byToolkit = new Map<string, string[]>();
  for (const [slug, configs] of found) {
    byToolkit.set(slug, configs.sort((a, b) => b.updated.localeCompare(a.updated)).map(({ id }) => id));
    offForToolRouter.delete(slug);
  }
  return { byToolkit, usable, offForToolRouter };
}

const listings = new Map<string, ListingEntry>();
const listingReads = new Map<string, Promise<ListingEntry>>();
const loggedChoices = new Map<string, string>();

/** Separates per-project state without keeping another plaintext copy of the key. */
function projectFingerprint(apiKey: string): string {
  return createHash("sha256").update("composio-project\0").update(apiKey.trim()).digest("hex");
}

function refreshListing(apiKey: string, project: string): Promise<ListingEntry> {
  const pending = listingReads.get(project);
  if (pending) return pending;
  const read = readListing(apiKey).then(
    (listing): ListingEntry => ({ listing, expiresAt: Date.now() + LISTING_TTL_MS }),
    (error): ListingEntry => {
      const readError = error instanceof Error ? error.message : String(error);
      console.warn(`[composio] could not read the project's auth configs (${readError}); Sessions keep the last list`);
      const previous = listings.get(project)?.listing;
      return {
        listing: previous ?? { byToolkit: new Map(), usable: new Map(), offForToolRouter: new Set() },
        expiresAt: Date.now() + LISTING_RETRY_MS,
        readError,
      };
    },
  ).then((entry) => {
    listings.set(project, entry);
    return entry;
  }).finally(() => listingReads.delete(project));
  listingReads.set(project, read);
  return read;
}

/** The auth configs a Session for this project should name. Never throws: a failed read keeps the last list (or none). */
export async function projectAuthConfigs(apiKey: string, options: { fresh?: boolean } = {}): Promise<ProjectAuthConfigs> {
  const project = projectFingerprint(apiKey);
  const cached = listings.get(project);
  const entry = !options.fresh && cached && Date.now() < cached.expiresAt ? cached : await refreshListing(apiKey, project);
  const picked = authConfigPicks(project);
  const configs: AuthConfigMap = {};
  for (const [slug, ids] of entry.listing.byToolkit) {
    const pick = picked[slug];
    const chosen = pick && entry.listing.usable.get(pick) === slug ? pick : ids[0]!;
    configs[slug] = chosen;
    const logKey = `${project}:${slug}`;
    if (ids.length > 1 && chosen !== pick && loggedChoices.get(logKey) !== chosen) {
      loggedChoices.set(logKey, chosen);
      console.info(`[composio] ${ids.length} enabled auth configs for ${slug}; using the most recently updated, ${chosen}`);
    }
  }
  return {
    configs: Object.fromEntries(Object.entries(configs).sort(([a], [b]) => a.localeCompare(b))),
    offForToolRouter: [...entry.listing.offForToolRouter].sort(),
    ...(entry.readError ? { readError: entry.readError } : {}),
  };
}

/** The next lookup reads Composio again, as when a call just failed for want of an auth config; a project's last list
 * stays the fallback. */
export function forgetProjectAuthConfigs(apiKey?: string): void {
  if (apiKey === undefined) listings.clear();
  const entry = apiKey === undefined ? undefined : listings.get(projectFingerprint(apiKey));
  if (entry) entry.expiresAt = 0;
}

const picksFileSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.record(z.string(), z.string().regex(AUTH_CONFIG_ID))),
});
let picks: Record<string, AuthConfigMap> | undefined;

const picksFile = () => join(DATA_DIR, "composio-auth-configs.json");

function authConfigPicks(project: string): AuthConfigMap {
  if (!picks) {
    try {
      picks = picksFileSchema.parse(JSON.parse(readFileSync(picksFile(), "utf8"))).projects;
    } catch {
      picks = {};
    }
  }
  return picks[project] ?? {};
}

export function noAuthConfigReason(toolkit: string): string {
  return `${toolkit} has no Composio-managed sign-in. In your Composio project, create an auth config for "${toolkit}" `
    + "(Auth Configs → Create) with your own app credentials, then click Connect again.";
}

export function offForToolRouterReason(toolkit: string): string {
  return `Your ${toolkit} auth config is not enabled for Tool Router. Enable it for Tool Router in your Composio project, then connect ${toolkit} again.`;
}

export function refusedAuthConfigReason(toolkit: string, said: string): string {
  return `Composio would not use your ${toolkit} auth config. Check it is enabled, and enabled for Tool Router, in your Composio project. Composio said: ${said}`;
}

/** A bot's explicit `auth_config_id`, checked against the project before any Session names it. */
async function checkAuthConfigPick(apiKey: string, toolkit: string, id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/auth_configs/${encodeURIComponent(id)}`, {
    headers: projectHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 400 || res.status === 404) {
    throw inputError(`Composio has no auth config ${id} in the project OpenMausBot uses. Copy the id from Auth Configs in that Composio project.`);
  }
  if (!res.ok) throw new Error(await responseError(res, `Composio auth config: HTTP ${res.status}`));
  const item = authConfigItemSchema.parse(await res.json());
  const owner = item.toolkit?.slug ? canonicalToolkitSlug(item.toolkit.slug) : toolkit;
  if (owner !== toolkit) throw inputError(`Auth config ${id} is for ${owner}, not ${toolkit}.`);
  if (item.is_composio_managed === true) {
    throw inputError(`Auth config ${id} is Composio's own sign-in for ${toolkit}, which OpenMausBot already uses, so no auth_config_id is needed.`);
  }
  if (!usableConfig(item)) throw inputError(`Auth config ${id} for ${toolkit} is disabled. Enable it in your Composio project, then connect again.`);
  if (item.is_enabled_for_tool_router === false) throw inputError(offForToolRouterReason(toolkit));
}

/** Checks a bot's pick and keeps it for this project's later Sessions; it wins over the newest config while it stays usable. */
export async function keepAuthConfigPick(apiKey: string, toolkit: string, id: string): Promise<void> {
  await checkAuthConfigPick(apiKey, toolkit, id);
  const project = projectFingerprint(apiKey);
  authConfigPicks(project);
  picks = { ...picks, [project]: { ...picks?.[project], [toolkit]: id } };
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(picksFile(), `${JSON.stringify({ version: 1, projects: picks }, null, 2)}\n`, { mode: 0o600 });
  forgetProjectAuthConfigs(apiKey);
}
