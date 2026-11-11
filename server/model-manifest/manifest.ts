// Adapted from apps/server/src/provider/ModelManifest.ts at commit e85e0094, MIT License, Copyright (c) 2026 T3 Tools Inc.
// (full text in third_party/t3-code/LICENSE); modified: a plain class with async fetches in place of an Effect service,
// and the picker's ModelCatalog in place of provider snapshots.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelCatalog } from "../contracts.ts";
import { parseVersionTriple, versionAtLeast, type VersionTriple } from "../drivers/acp/version-probe.ts";
import { BUNDLED_MODEL_MANIFEST, bundledEngineCatalog, engineCatalogFrom } from "./bundled.ts";
import { parseModelManifest, type ManifestEngine, type ManifestPrice, type ModelManifestData } from "./schema.ts";

export const MODEL_MANIFEST_URL = "https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/server/model-manifest/model-manifest.json";
export const MANIFEST_DISABLE_ENV = "OMB_DISABLE_MODEL_MANIFEST_FETCH";
export const MANIFEST_TTL_MS = 60 * 60 * 1000;
/** GitHub's raw CDN caches about this long, so a shorter window buys nothing. */
export const MANIFEST_ON_DEMAND_TTL_MS = 5 * 60 * 1000;
/** Back off failed fetches so a computer that is offline does not try on every model-list open. */
export const MANIFEST_RETRY_MS = 5 * 60 * 1000;
export const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
export const MANIFEST_MAX_BYTES = 512 * 1024;

/** Under providers/, so backups and Move to Cloud leave it out. */
export function modelManifestCachePath(dataDir: string): string {
  return join(dataDir, "providers", "model-manifest", "model-manifest.json");
}

export interface ModelManifestOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  bundled?: ModelManifestData;
  timeoutMs?: number;
  maxBytes?: number;
  log?: (message: string) => void;
}

function updatedAtMs(manifest: ModelManifestData): number {
  return Date.parse(manifest.updatedAt);
}

export class ModelManifestStore {
  private readonly options: ModelManifestOptions;
  private readonly bundled: ModelManifestData;
  private readonly cachePath: string;
  private manifest: ModelManifestData;
  private fetchedAtMs: number | null = null;
  private lastAttemptMs: number | null = null;
  private diskChecked = false;
  private inflight: Promise<ModelManifestData> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(options: ModelManifestOptions) {
    this.options = options;
    this.bundled = options.bundled ?? BUNDLED_MODEL_MANIFEST;
    this.manifest = this.bundled;
    this.cachePath = modelManifestCachePath(options.dataDir);
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(text: string): void {
    (this.options.log ?? ((line: string) => console.warn(line)))(`[model-manifest] ${text}`);
  }

  get fetchDisabled(): boolean {
    return (this.options.env ?? process.env)[MANIFEST_DISABLE_ENV] === "1";
  }

  /** The newest usable manifest. Reads the disk cache once and never waits on the network. */
  current(): ModelManifestData {
    if (!this.diskChecked) this.loadDiskCache();
    return this.manifest;
  }

  /** Called after a download replaces the current list with a different one. Returns its unsubscriber. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Skipped inside `ttlMs` of the last good fetch and for a while after a failed one, unless `force`. Concurrent calls share one request. Never throws. */
  refresh(options: { force?: boolean; ttlMs?: number } = {}): Promise<ModelManifestData> {
    if (this.fetchDisabled) return Promise.resolve(this.current());
    this.inflight ??= this.fetchAndStore(Boolean(options.force), options.ttlMs ?? MANIFEST_TTL_MS).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** For someone opening the model list: tolerates far less staleness than the background refresh. */
  refreshOnDemand(): Promise<ModelManifestData> {
    return this.refresh({ ttlMs: MANIFEST_ON_DEMAND_TTL_MS });
  }

  refreshInBackground(): void {
    void this.refresh().catch((error: unknown) => this.log(`refresh failed: ${message(error)}`));
  }

  private loadDiskCache(): void {
    this.diskChecked = true;
    try {
      if (!existsSync(this.cachePath) || statSync(this.cachePath).size > this.maxBytes * 2) return;
      const raw = JSON.parse(readFileSync(this.cachePath, "utf8")) as { fetchedAtMs?: unknown; manifest?: unknown };
      const parsed = parseModelManifest(raw.manifest, { nowMs: this.now });
      if (!parsed.ok) {
        this.log(`ignoring the cached manifest (${parsed.error})`);
        return;
      }
      // A release can correct a model before the next successful fetch, so an older cache must not hide its copy.
      if (updatedAtMs(this.bundled) > updatedAtMs(parsed.manifest)) return;
      this.manifest = parsed.manifest;
      this.fetchedAtMs = typeof raw.fetchedAtMs === "number" && Number.isFinite(raw.fetchedAtMs) ? raw.fetchedAtMs : null;
    } catch (error) {
      this.log(`could not read the cached manifest (${message(error)})`);
    }
  }

  private get maxBytes(): number {
    return this.options.maxBytes ?? MANIFEST_MAX_BYTES;
  }

  private async fetchAndStore(force: boolean, ttlMs: number): Promise<ModelManifestData> {
    this.current();
    const now = this.now;
    // Expire timestamps from the future after a clock rollback; disk caches cross restarts, so a monotonic clock cannot be used.
    const within = (sinceMs: number | null, windowMs: number) => sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
    if (!force && within(this.fetchedAtMs, ttlMs)) return this.manifest;
    if (!force && within(this.lastAttemptMs, MANIFEST_RETRY_MS)) return this.manifest;
    this.lastAttemptMs = now;

    let fetched: ModelManifestData;
    try {
      fetched = await this.download();
    } catch (error) {
      this.log(`could not refresh the model list (${message(error)}); keeping the current one`);
      return this.manifest;
    }
    // A stale CDN copy loses to what we already have, so it cannot bring back a model a newer copy removed.
    if (updatedAtMs(fetched) < updatedAtMs(this.manifest)) {
      this.log(`ignoring a downloaded list older than the current one (${fetched.updatedAt})`);
      return this.manifest;
    }
    const changed = JSON.stringify(fetched) !== JSON.stringify(this.manifest);
    this.manifest = fetched;
    this.fetchedAtMs = now;
    this.lastAttemptMs = null;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileAtomic(this.cachePath, JSON.stringify({ fetchedAtMs: now, manifest: fetched }));
    } catch (error) {
      this.log(`could not save the downloaded model list (${message(error)})`);
    }
    if (changed) {
      for (const listener of this.listeners) {
        try { listener(); } catch (error) { this.log(`a listener failed (${message(error)})`); }
      }
    }
    return this.manifest;
  }

  private async download(): Promise<ModelManifestData> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS);
    try {
      const response = await (this.options.fetch ?? fetch)(MODEL_MANIFEST_URL, {
        headers: { accept: "application/json", "user-agent": "OpenMausBot" },
        // raw.githubusercontent.com answers directly; anywhere else is not the file we meant to read.
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`larger than ${this.maxBytes} bytes`);
      }
      const text = await readCapped(response, this.maxBytes);
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
      const parsed = parseModelManifest(json, { nowMs: this.now });
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.manifest;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("it did not answer in time");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let store: ModelManifestStore | undefined;

export function modelManifest(): ModelManifestStore {
  return store ??= new ModelManifestStore({ dataDir: DATA_DIR });
}

let backgroundTimer: ReturnType<typeof setInterval> | undefined;

/** A sleeping machine's timers pause; the on-demand refresh covers the picker when it wakes. */
export function startModelManifestRefresh(): void {
  if (backgroundTimer) return;
  modelManifest().refreshInBackground();
  backgroundTimer = setInterval(() => modelManifest().refreshInBackground(), MANIFEST_TTL_MS);
  backgroundTimer.unref();
}

/** The current list for an engine, or the bundled one for an engine a download left out. */
export function currentEngineCatalog(engine: ManifestEngine, source: ModelManifestStore = modelManifest()): ModelCatalog {
  return engineCatalogFrom(source.current(), engine) ?? bundledEngineCatalog(engine);
}

export function minCliVersionFor(engine: ManifestEngine, modelId: string, manifest: ModelManifestData): string | null {
  return manifest.engines[engine]?.models.find((model) => model.id === modelId)?.minCliVersion ?? null;
}

/** Marks models the installed CLI is too old for, so the picker offers the update instead of a turn that fails. An
 * unknown version marks nothing: the CLI's own "does not support this model" reply still reaches the update card. */
export function withCliVersionGate(catalog: ModelCatalog, engine: ManifestEngine, version: VersionTriple | null, source: ModelManifestStore = modelManifest()): ModelCatalog {
  const manifest = source.current();
  const options: ModelCatalog["options"] = catalog.options.map(({ needsCliUpdate: _stale, ...option }) => {
    if (option.custom || version === null) return option;
    const floor = minCliVersionFor(engine, option.id, manifest);
    const needed = floor ? parseVersionTriple(floor) : null;
    return needed && floor && !versionAtLeast(version, needed) ? { ...option, needsCliUpdate: floor } : option;
  });
  const usable = (id: string) => options.some((option) => option.id === id && !option.needsCliUpdate);
  const fallback = options.find((option) => !option.needsCliUpdate && !option.custom)?.id;
  return { ...catalog, default: usable(catalog.default) ? catalog.default : fallback ?? catalog.default, options };
}

/** The manifest's list prices and the model each alias names (Antigravity's thinking-level ids). */
export function currentPrices(): { prices: Readonly<Record<string, ManifestPrice>>; aliases: ReadonlyMap<string, string> } {
  const manifest = modelManifest().current();
  const aliases = new Map<string, string>();
  for (const engine of Object.values(manifest.engines)) {
    for (const model of engine?.models ?? []) for (const alias of model.aliases ?? []) aliases.set(alias.toLowerCase(), model.id);
  }
  return { prices: manifest.prices ?? BUNDLED_MODEL_MANIFEST.prices!, aliases };
}
