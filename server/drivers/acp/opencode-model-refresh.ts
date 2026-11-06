import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { openCodeModelId } from "../../../shared/opencode-model-id.ts";
import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { declareOpenCodeModels } from "./opencode-typed-model.ts";

export interface LiveModelList {
  /** OpenCode's id for the provider. */
  provider: string;
  /** The variable OpenCode reads the provider's key from. */
  env: string;
  /** An OpenAI-style listing: `{ data: [{ id }] }`. */
  url: string;
  keep?: (entry: Record<string, unknown>) => boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Providers whose own listing holds only models OpenCode can chat with, so it can be offered as it is. */
export const OPENCODE_LIVE_MODEL_LISTS: readonly LiveModelList[] = [
  {
    provider: "venice",
    env: "VENICE_API_KEY",
    url: "https://api.venice.ai/api/v1/models?type=text",
    // Venice serves its end-to-end encrypted models only to a client that encrypts the prompt itself; models.dev
    // (2026-11-07) lists none of them for OpenCode.
    keep: (entry) => record(record(entry.model_spec).capabilities).supportsE2EE !== true,
  },
];

export const OPENCODE_MODEL_REFRESH_MS = 3 * 60 * 60_000;
const REFRESH_CHECK_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 2_000;

interface Stored {
  /** Each provider's last listing that answered. */
  providers: Record<string, { checkedAt: number; models: string[] }>;
  /** When each OpenCode instance last read its models past OpenCode's own catalog cache. */
  refreshedAt: Record<string, number>;
}

let memo: Stored | null = null;

const storePath = () => join(DATA_DIR, "providers", "opencode", "live-models.json");

function load(): Stored {
  if (memo) return memo;
  memo = { providers: {}, refreshedAt: {} };
  try {
    const raw = record(JSON.parse(readFileSync(storePath(), "utf8")));
    for (const [provider, value] of Object.entries(record(raw.providers))) {
      const entry = record(value);
      const models = Array.isArray(entry.models) ? entry.models.filter((id): id is string => typeof id === "string") : [];
      if (typeof entry.checkedAt === "number" && models.length) memo.providers[provider] = { checkedAt: entry.checkedAt, models };
    }
    for (const [instanceId, at] of Object.entries(record(raw.refreshedAt))) {
      if (typeof at === "number" && Number.isFinite(at)) memo.refreshedAt[instanceId] = at;
    }
  } catch {}
  return memo;
}

function save(): void {
  try {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileAtomic(storePath(), JSON.stringify(load()), { durable: false });
  } catch {}
}

export function openCodeCatalogRefreshedAt(instanceId: string): number {
  return load().refreshedAt[instanceId] ?? 0;
}

export function markOpenCodeCatalogRefreshed(instanceId: string, at: number): void {
  load().refreshedAt[instanceId] = at;
  save();
}

async function readListing(list: LiveModelList, key: string, fetcher: typeof fetch): Promise<string[]> {
  const response = await fetcher(list.url, {
    headers: { accept: "application/json", authorization: `Bearer ${key}`, "user-agent": "OpenMausBot" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("the listing is too large");
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("the listing is too large");
  const data = record(JSON.parse(text)).data;
  if (!Array.isArray(data)) throw new Error("the listing has no data");
  const ids = new Set<string>();
  for (const value of data) {
    const entry = record(value);
    if (typeof entry.id !== "string" || (list.keep && !list.keep(entry))) continue;
    if (openCodeModelId(`${list.provider}/${entry.id}`) === `${list.provider}/${entry.id}`) ids.add(entry.id);
    if (ids.size >= MAX_MODELS) break;
  }
  return [...ids].sort();
}

/** Reads the listing of every provider whose key `env` holds. A listing that fails keeps the last one that answered. */
export async function refreshLiveModelLists(
  env: Record<string, string | undefined>,
  options: { lists?: readonly LiveModelList[]; fetch?: typeof fetch; now?: () => number } = {},
): Promise<void> {
  const store = load();
  let changed = false;
  await Promise.all((options.lists ?? OPENCODE_LIVE_MODEL_LISTS).map(async (list) => {
    const key = env[list.env]?.trim();
    if (!key) return;
    try {
      const models = await readListing(list, key, options.fetch ?? fetch);
      if (!models.length) throw new Error("the listing names no model");
      store.providers[list.provider] = { checkedAt: (options.now ?? Date.now)(), models };
      changed = true;
    } catch (error) {
      console.warn(`[opencode] could not read ${list.provider}'s model list (${error instanceof Error ? error.message : String(error)}); keeping the last one`);
    }
  }));
  if (changed) save();
}

/** Declares to OpenCode the last listed models of every provider whose key `env` holds. */
export function declareLiveOpenCodeModels(
  env: Record<string, string | undefined>,
  lists: readonly LiveModelList[] = OPENCODE_LIVE_MODEL_LISTS,
): void {
  const store = load();
  declareOpenCodeModels(env, Object.fromEntries(lists.flatMap((list) => {
    const models = store.providers[list.provider]?.models;
    return env[list.env]?.trim() && models?.length ? [[list.provider, models]] : [];
  })));
}

export function resetLiveModelLists(): void {
  memo = null;
}

export interface OpenCodeModelSources {
  liveLists?: readonly LiveModelList[];
  fetch?: typeof fetch;
  now?: () => number;
}

export interface OpenCodeRefreshSchedule extends OpenCodeModelSources {
  everyMs?: number;
  checkMs?: number;
}

/** Reads the instance's models again past every cache once they are `everyMs` old: checked once its start-up read is
 * done and every `checkMs` after, on the wall clock, which keeps counting while a Cloud is suspended. */
export function keepOpenCodeModelsFresh(instance: ProviderInstance, instanceId: string, schedule: OpenCodeRefreshSchedule = {}): void {
  const now = schedule.now ?? Date.now;
  let disposed = false;
  const refreshWhenDue = () => {
    if (!disposed && now() - openCodeCatalogRefreshedAt(instanceId) >= (schedule.everyMs ?? OPENCODE_MODEL_REFRESH_MS)) {
      void instance.refreshModels?.().catch(() => {});
    }
  };
  const timer = setInterval(refreshWhenDue, schedule.checkMs ?? REFRESH_CHECK_MS);
  timer.unref?.();
  void (instance.startupModelRefresh ?? Promise.resolve()).then(refreshWhenDue, refreshWhenDue);
  const dispose = instance.dispose.bind(instance);
  instance.dispose = async () => {
    disposed = true;
    clearInterval(timer);
    await dispose();
  };
}
