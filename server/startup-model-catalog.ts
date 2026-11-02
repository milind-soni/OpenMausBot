import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelCatalog } from "./contracts.ts";
import { buildStamp } from "./environment.ts";
import { afterFirstEngineRead } from "./first-engine-read.ts";

const SAFE_INSTANCE_ID = /^[\w.-]+$/;
/** A list this server's build read this recently is used as it is at start; an older one, or one an earlier build read,
 * is read again in the background. A sleeping Cloud wakes many times an hour, and each read can start the engine's CLI. */
export const STARTUP_MODEL_CACHE_FRESH_MS = 6 * 60 * 60_000;

export function startupModelCachePath(instanceId: string): string | null {
  if (!SAFE_INSTANCE_ID.test(instanceId)) return null;
  return join(DATA_DIR, "providers", "engine-models", `${instanceId}.json`);
}

export function laterStartup(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function variantList(value: unknown): Array<{ id: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const variant = entry as { id?: unknown; label?: unknown };
    return typeof variant.id === "string" && typeof variant.label === "string"
      ? [{ id: variant.id, label: variant.label }]
      : [];
  });
  return variants.length ? variants : undefined;
}

function catalogFrom(value: unknown): ModelCatalog | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { default?: unknown; options?: unknown };
  if (typeof raw.default !== "string" || !Array.isArray(raw.options) || raw.options.length === 0) return null;
  const options: ModelCatalog["options"] = [];
  for (const entry of raw.options) {
    if (!entry || typeof entry !== "object") return null;
    const option = entry as {
      id?: unknown;
      label?: unknown;
      custom?: unknown;
      loaded?: unknown;
      provider?: unknown;
      contextWindow?: unknown;
      variants?: unknown;
      orgBlocked?: unknown;
    };
    if (typeof option.id !== "string" || typeof option.label !== "string") return null;
    const variants = variantList(option.variants);
    options.push({
      id: option.id,
      label: option.label,
      ...(option.custom === true ? { custom: true } : {}),
      ...(option.loaded === true ? { loaded: true } : {}),
      ...(typeof option.provider === "string" ? { provider: option.provider } : {}),
      ...(typeof option.contextWindow === "number" && Number.isFinite(option.contextWindow)
        ? { contextWindow: option.contextWindow }
        : {}),
      ...(variants ? { variants } : {}),
      ...(option.orgBlocked === true ? { orgBlocked: true as const } : {}),
    });
  }
  return { default: raw.default, options };
}

const unconfirmed = new WeakSet<ModelCatalog>();

/** The engine did not give this list (its CLI timed out, or answered nothing): it is saved, but read again at the next start. */
export function unconfirmedModelCatalog(catalog: ModelCatalog): void {
  unconfirmed.add(catalog);
}

export interface StartupModelCacheEntry {
  catalog: ModelCatalog;
  checkedAt: number | null;
  build: string | null;
}

/** `standIn`: the engine's own stand-in list. A saved copy of it, which builds before `placeholder` wrote after a failed
 * read, is no catalog: it reads as nothing, so the stand-in comes back marked. A list this build saved is `discovered`
 * and always kept, even one that lists only what the stand-in lists. */
export function readStartupModelCacheEntry(instanceId: string, standIn?: ModelCatalog): StartupModelCacheEntry | null {
  const path = startupModelCachePath(instanceId);
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { checkedAt?: unknown; build?: unknown; discovered?: unknown } | null;
    const catalog = catalogFrom(raw);
    const ids = (listed: ModelCatalog) => listed.options.map((option) => option.id).join("\0");
    if (!catalog || (raw?.discovered !== true && standIn?.placeholder && ids(catalog) === ids(standIn))) return null;
    return {
      catalog,
      checkedAt: typeof raw?.checkedAt === "number" && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
      build: typeof raw?.build === "string" ? raw.build : null,
    };
  } catch {
    return null;
  }
}

export function readStartupModelCache(instanceId: string, standIn?: ModelCatalog): ModelCatalog | null {
  return readStartupModelCacheEntry(instanceId, standIn)?.catalog ?? null;
}

/** A stand-in list (`placeholder`) is never saved: it would come back unmarked at the next start. */
export function writeStartupModelCache(instanceId: string, catalog: ModelCatalog, read: { checkedAt?: number; build?: string } = {}): void {
  if (!catalog.options.length || catalog.placeholder) return;
  const path = startupModelCachePath(instanceId);
  if (!path) return;
  const stored = catalogFrom(catalog);
  if (!stored) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify({ ...stored, discovered: true, checkedAt: read.checkedAt ?? (unconfirmed.has(catalog) ? 0 : Date.now()), build: read.build ?? buildStamp() }), { durable: false });
}

/** An object, not a promise: an async function cannot hand back a promise without `await` following it. */
export type DeferredStartupModelRefresh = { pending: Promise<void> };

export function openStartupModelCatalog(input: {
  instanceId: string;
  use: (catalog: ModelCatalog) => void;
  current: () => ModelCatalog;
  refresh: () => Promise<void>;
  now?: number;
}): Promise<null> | DeferredStartupModelRefresh {
  const entry = readStartupModelCacheEntry(input.instanceId);
  const cached = entry?.catalog ?? null;
  if (cached) input.use(cached);
  const persist = () => {
    try {
      writeStartupModelCache(input.instanceId, input.current());
    } catch {
    }
  };
  if (!laterStartup()) {
    return input.refresh().then(() => {
      persist();
      return null;
    });
  }
  const age = (input.now ?? Date.now()) - (entry?.checkedAt ?? -Infinity);
  if (cached && entry?.build === buildStamp() && age >= 0 && age < STARTUP_MODEL_CACHE_FRESH_MS) return Promise.resolve(null);
  // A saved list stands in while the refresh waits; with none the engine would offer no model at all until it runs.
  const startAfter = cached ? afterFirstEngineRead() : Promise.resolve();
  return { pending: startAfter.then(() => input.refresh()).then(persist, () => undefined) };
}
