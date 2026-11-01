import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelCatalog } from "./contracts.ts";
import { afterFirstEngineRead } from "./first-engine-read.ts";

const SAFE_INSTANCE_ID = /^[\w.-]+$/;

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
    });
  }
  return { default: raw.default, options };
}

/** `standIn`: the engine's own stand-in list. A saved copy of it, which builds before `placeholder` wrote after a failed
 * read, is no catalog: it reads as nothing, so the stand-in comes back marked. A list this build saved is `discovered`
 * and always kept, even one that lists only what the stand-in lists. */
export function readStartupModelCache(instanceId: string, standIn?: ModelCatalog): ModelCatalog | null {
  const path = startupModelCachePath(instanceId);
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const cached = catalogFrom(raw);
    const legacy = (raw as { discovered?: unknown } | null)?.discovered !== true;
    const ids = (catalog: ModelCatalog) => catalog.options.map((option) => option.id).join("\0");
    return cached && legacy && standIn?.placeholder && ids(cached) === ids(standIn) ? null : cached;
  } catch {
    return null;
  }
}

/** A stand-in list (`placeholder`) is never saved: it would come back unmarked at the next start. */
export function writeStartupModelCache(instanceId: string, catalog: ModelCatalog): void {
  if (!catalog.options.length || catalog.placeholder) return;
  const path = startupModelCachePath(instanceId);
  if (!path) return;
  const stored = catalogFrom(catalog);
  if (!stored) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify({ ...stored, discovered: true }), { durable: false });
}

/** An object, not a promise: an async function cannot hand back a promise without `await` following it. */
export type DeferredStartupModelRefresh = { pending: Promise<void> };

export function openStartupModelCatalog(input: {
  instanceId: string;
  use: (catalog: ModelCatalog) => void;
  current: () => ModelCatalog;
  refresh: () => Promise<void>;
}): Promise<null> | DeferredStartupModelRefresh {
  const cached = readStartupModelCache(input.instanceId);
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
  // A saved list stands in while the refresh waits; with none the engine would offer no model at all until it runs.
  const startAfter = cached ? afterFirstEngineRead() : Promise.resolve();
  return { pending: startAfter.then(() => input.refresh()).then(persist, () => undefined) };
}
