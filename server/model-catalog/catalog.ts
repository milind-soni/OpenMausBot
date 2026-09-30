/*! Adapted from anomalyco/opencode@2fa3363c924c5c3e367b84a87ae478296a0ed59b
 * packages/core/src/models-dev.ts:160-258, MIT; modified.
 *
 * MIT License
 *
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// The model provider catalog: load it, keep it fresh, merge in the presets.
//
// Kept from OpenCode's models-dev.ts: a cache file refreshed from
// models.dev/api.json with a 10 s timeout, written through a temp file and a
// rename; a corrupt cache is deleted; a snapshot bundled with the app; a
// forced refresh skips the freshness check; failures are logged and never
// surface; one switch turns fetching off.
//
// Changed for OpenMausBot:
// - plain Node instead of Effect; one server process owns DATA_DIR, so a
//   single in-flight promise stands in for OpenCode's cross-process flock;
// - data counts as fresh for 24 hours, and a refresh runs only when asked
//   (Settings or the model picker opening), not on a timer;
// - If-None-Match with the stored ETag, a 20 MB cap, redirects refused;
// - every source is trimmed and brace-filtered (trim.ts) before use;
// - the source is the newest of: our cache, OpenCode's own cache
//   (~/.cache/opencode/models.json, read only), the bundled snapshot. On a tie
//   that order decides, so a newer snapshot beats an older cache;
// - switched off by OMB_DISABLE_MODEL_CATALOG_FETCH=1, and by the caller on
//   managed or hosted installs.
//
// This list is never the last word on what a key can use: the provider's own
// /models, called with the key, is. The catalog supplies names, key variable
// names, base URLs and the capability flags used to pick recommended models.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../atomic.ts";
import { OPENAI_COMPATIBLE_NPM, PROVIDER_PRESETS, type ProviderPreset } from "./presets.ts";
import {
  MODEL_CATALOG_SCHEMA,
  catalogStats,
  packCatalog,
  trimModelsDevCatalog,
  unpackCatalog,
  type CatalogProviders,
  type ModelCatalogDocument,
} from "./trim.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CATALOG_FETCH_TIMEOUT_MS = 10_000;
export const CATALOG_MAX_BYTES = 20 * 1024 * 1024;
export const CATALOG_DISABLE_ENV = "OMB_DISABLE_MODEL_CATALOG_FETCH";
export const SNAPSHOT_FILE = "models-dev.snapshot.json";

export type CatalogOrigin = "cache" | "opencode" | "snapshot" | "empty";

export interface ModelCatalog {
  origin: CatalogOrigin;
  /** When the data was last known to match models.dev (ISO 8601). */
  updatedAt: string;
  providers: CatalogProviders;
}

export type CatalogRefreshResult = "disabled" | "fresh" | "updated" | "not-modified" | "failed";

export interface ModelCatalogOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** True on managed and hosted installs: never fetch. */
  fetchDisabled?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** The bundled snapshot's text. Defaults to the file shipped beside this module. */
  readSnapshot?: () => string | undefined;
  /** OpenCode's catalog cache. Defaults to its XDG cache path; null skips it. */
  openCodeCachePath?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  log?: (message: string) => void;
}

/** Our cache, under providers/ so backups and Move to Cloud leave it out. */
export function modelCatalogCachePath(dataDir: string): string {
  return join(dataDir, "providers", "model-providers", "models-dev.json");
}

/** Where OpenCode keeps models.dev (xdg-basedir's cache dir, on every OS). */
export function openCodeCatalogCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json");
}

/** The snapshot sits beside this module in a checkout, and under
 * model-catalog/ beside the bundled server (scripts/bundle-server.mjs). */
function readBundledSnapshot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, SNAPSHOT_FILE), join(here, "model-catalog", SNAPSHOT_FILE)]) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
// An ETag is echoed back in a request header: keep only a plain, short one.
const safeEtag = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 256 && !CONTROL.test(value) ? value : undefined;

const time = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Candidate {
  origin: Exclude<CatalogOrigin, "empty">;
  updatedAt: number;
  /** Raw providers, trimmed only if this candidate is chosen. */
  providers: () => unknown;
}

export class ModelCatalogStore {
  private readonly options: ModelCatalogOptions;
  private readonly cachePath: string;
  private memo: ModelCatalog | undefined;
  private inflight: Promise<CatalogRefreshResult> | undefined;

  constructor(options: ModelCatalogOptions) {
    this.options = options;
    this.cachePath = modelCatalogCachePath(options.dataDir);
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(text: string): void {
    (this.options.log ?? ((line: string) => console.warn(line)))(`[model-catalog] ${text}`);
  }

  get fetchDisabled(): boolean {
    return Boolean(this.options.fetchDisabled) || (this.options.env ?? process.env)[CATALOG_DISABLE_ENV] === "1";
  }

  /** The newest usable catalog. Never throws; worst case an empty catalog. */
  get(): ModelCatalog {
    if (this.memo) return this.memo;
    const candidates = [this.ownCache(), this.openCodeCache(), this.snapshot()]
      .filter((candidate): candidate is Candidate => candidate !== undefined);
    // Stable sort: on equal times the listed order (cache, OpenCode, snapshot) wins.
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const candidate of candidates) {
      let drops = 0;
      const providers = trimModelsDevCatalog(candidate.providers(), { onDrop: () => { drops += 1; } });
      if (!Object.keys(providers).length) {
        this.log(`the ${candidate.origin} catalog held no usable providers; trying the next one`);
        continue;
      }
      if (drops) this.log(`left out ${drops} ${candidate.origin} catalog entries that were malformed or contained { or }`);
      this.memo = { origin: candidate.origin, updatedAt: new Date(candidate.updatedAt).toISOString(), providers };
      return this.memo;
    }
    this.memo = { origin: "empty", updatedAt: new Date(0).toISOString(), providers: trimModelsDevCatalog(undefined) };
    return this.memo;
  }

  /** Refresh from models.dev unless the cache is under 24 hours old (or
   * `force`). Concurrent calls share one request. Never throws. */
  refresh(options: { force?: boolean } = {}): Promise<CatalogRefreshResult> {
    if (this.fetchDisabled) return Promise.resolve("disabled");
    this.inflight ??= this.fetchAndStore(Boolean(options.force)).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private readDocument(): { doc: ModelCatalogDocument; updatedAt: number } | undefined {
    if (!existsSync(this.cachePath)) return undefined;
    try {
      if (statSync(this.cachePath).size > (this.options.maxBytes ?? CATALOG_MAX_BYTES)) throw new Error("too large");
      const doc = JSON.parse(readFileSync(this.cachePath, "utf8")) as ModelCatalogDocument;
      const updatedAt = time(doc?.updatedAt);
      if (doc?.schema !== MODEL_CATALOG_SCHEMA || updatedAt === undefined || !doc.providers) throw new Error("unrecognised format");
      return { doc, updatedAt };
    } catch (error) {
      // As OpenCode does, drop a cache we cannot read; the next refresh rewrites it.
      this.log(`removed an unreadable catalog cache (${message(error)})`);
      try { rmSync(this.cachePath, { force: true }); } catch { /* best effort */ }
      return undefined;
    }
  }

  private ownCache(): Candidate | undefined {
    const cached = this.readDocument();
    return cached && { origin: "cache", updatedAt: cached.updatedAt, providers: () => unpackCatalog(cached.doc.providers) };
  }

  private openCodeCache(): Candidate | undefined {
    const path = this.options.openCodeCachePath === undefined
      ? openCodeCatalogCachePath(this.options.env ?? process.env)
      : this.options.openCodeCachePath;
    if (!path) return undefined;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > (this.options.maxBytes ?? CATALOG_MAX_BYTES)) return undefined;
      // Read only if chosen: it is models.dev's full 5 MB catalog.
      return { origin: "opencode", updatedAt: stat.mtimeMs, providers: () => {
        try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
      } };
    } catch {
      return undefined;
    }
  }

  private snapshot(): Candidate | undefined {
    try {
      const text = (this.options.readSnapshot ?? readBundledSnapshot)();
      if (text === undefined) {
        this.log("the bundled catalog snapshot is missing");
        return undefined;
      }
      const doc = JSON.parse(text) as ModelCatalogDocument;
      const updatedAt = time(doc?.updatedAt);
      if (doc?.schema !== MODEL_CATALOG_SCHEMA || updatedAt === undefined) throw new Error("unrecognised format");
      return { origin: "snapshot", updatedAt, providers: () => unpackCatalog(doc.providers) };
    } catch (error) {
      this.log(`could not read the bundled catalog snapshot (${message(error)})`);
      return undefined;
    }
  }

  private async fetchAndStore(force: boolean): Promise<CatalogRefreshResult> {
    const cached = this.readDocument();
    const age = cached ? this.now - cached.updatedAt : Infinity;
    // A cache stamped in the future (clock moved back) counts as stale.
    if (!force && age >= 0 && age < CATALOG_MAX_AGE_MS) return "fresh";
    try {
      const etag = cached ? safeEtag(cached.doc.source?.etag) : undefined;
      const response = await this.download(etag);
      if (response.status === 304) {
        if (!cached) throw new Error("models.dev answered 304 without a cached copy");
        this.write({ ...cached.doc, updatedAt: new Date(this.now).toISOString() });
        this.memo = undefined;
        return "not-modified";
      }
      let raw: unknown;
      try { raw = JSON.parse(response.text); } catch { throw new Error("models.dev returned invalid JSON"); }
      let drops = 0;
      const providers = trimModelsDevCatalog(raw, { onDrop: () => { drops += 1; } });
      // Never replace a good cache with an empty one.
      if (!Object.keys(providers).length) throw new Error("models.dev returned no usable providers");
      this.write({
        schema: MODEL_CATALOG_SCHEMA,
        updatedAt: new Date(this.now).toISOString(),
        source: { name: "models.dev", url: MODELS_DEV_URL, license: "MIT", ...(response.etag ? { etag: response.etag } : {}) },
        providers: packCatalog(providers),
      });
      this.memo = undefined;
      const stats = catalogStats(providers);
      this.log(`updated from models.dev: ${stats.providers} providers, ${stats.models} models` +
        (drops ? `; left out ${drops} entries that were malformed or contained { or }` : ""));
      return "updated";
    } catch (error) {
      this.log(`could not refresh from models.dev (${message(error)}); keeping the current catalog`);
      return "failed";
    }
  }

  private write(doc: ModelCatalogDocument): void {
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileAtomic(this.cachePath, JSON.stringify(doc));
  }

  private async download(etag: string | undefined): Promise<{ status: 200; text: string; etag?: string } | { status: 304 }> {
    const maxBytes = this.options.maxBytes ?? CATALOG_MAX_BYTES;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS);
    try {
      const response = await (this.options.fetch ?? fetch)(MODELS_DEV_URL, {
        headers: { accept: "application/json", "user-agent": "OpenMausBot", ...(etag ? { "if-none-match": etag } : {}) },
        // Nothing secret is sent, but the catalog comes from models.dev only.
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 304 && etag) {
        void response.body?.cancel().catch(() => {});
        return { status: 304 };
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`models.dev returned HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`models.dev sent more than ${maxBytes} bytes`);
      }
      // The timer also covers reading the body.
      const text = await readCapped(response, maxBytes);
      return { status: 200, text, etag: safeEtag(response.headers.get("etag")) };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("models.dev did not answer in time");
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
      throw new Error(`models.dev sent more than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** One row of the "Add a provider" list: a models.dev provider, a preset, or both. */
export interface CatalogEntry {
  /** The preset id, else the models.dev id. */
  id: string;
  /** The models.dev provider, when the catalog has it. */
  catalogId?: string;
  label: string;
  env: string[];
  /** The AI SDK package that speaks to `api`. For a preset it can differ from
   * models.dev's `npm`, so OpenCode's block must set it along with baseURL. */
  npm?: string;
  /** OpenAI-compatible base URL. A preset's pinned URL wins over models.dev's. */
  api?: string;
  /** "Get a key" link; https only. */
  doc?: string;
  modelCount: number;
  recommended?: number;
  preset?: ProviderPreset;
}

/** The SDK package for a preset's pinned `api`. models.dev's `npm` describes
 * models.dev's `api` (or, when it lists none, the SDK's own default address,
 * which the preset pins too), so it is kept only when that is the address the
 * preset pins. Otherwise the pinned address is OpenAI-compatible by definition. */
function presetNpm(preset: ProviderPreset, provider: CatalogProviders[string] | undefined): string | undefined {
  if (preset.npm) return preset.npm;
  if (!provider?.npm) return undefined;
  return provider.api === undefined || provider.api === preset.api ? provider.npm : OPENAI_COMPATIBLE_NPM;
}

/** The catalog merged with the presets: recommended rows first, in their
 * order, then every other provider by name. Presets whose provider the
 * catalog lacks (or dropped) are still listed. */
export function catalogEntries(catalog: ModelCatalog, presets: readonly ProviderPreset[] = PROVIDER_PRESETS): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const covered = new Set<string>();
  for (const preset of presets) {
    const provider = preset.catalogId ? catalog.providers[preset.catalogId] : undefined;
    if (provider) covered.add(provider.id);
    const entry: CatalogEntry = {
      id: preset.id,
      label: preset.label,
      env: provider?.env ?? (preset.env ? [preset.env] : []),
      api: preset.api,
      modelCount: provider ? Object.keys(provider.models).length : 0,
      preset,
    };
    if (provider) entry.catalogId = provider.id;
    const npm = presetNpm(preset, provider);
    if (npm) entry.npm = npm;
    const doc = preset.doc ?? provider?.doc;
    if (doc) entry.doc = doc;
    if (preset.recommended !== undefined) entry.recommended = preset.recommended;
    entries.push(entry);
  }
  for (const provider of Object.values(catalog.providers)) {
    if (covered.has(provider.id) || presets.some((preset) => preset.id === provider.id)) continue;
    const entry: CatalogEntry = { id: provider.id, catalogId: provider.id, label: provider.name, env: provider.env, modelCount: Object.keys(provider.models).length };
    if (provider.npm) entry.npm = provider.npm;
    if (provider.api) entry.api = provider.api;
    if (provider.doc) entry.doc = provider.doc;
    entries.push(entry);
  }
  return entries.sort((a, b) =>
    (a.recommended ?? Infinity) - (b.recommended ?? Infinity) ||
    a.label.localeCompare(b.label, "en", { sensitivity: "base" }) ||
    a.id.localeCompare(b.id));
}
