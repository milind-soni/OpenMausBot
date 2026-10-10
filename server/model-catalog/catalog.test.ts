import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_DISABLE_ENV,
  MODELS_DEV_URL,
  ModelCatalogStore,
  catalogEntries,
  modelCatalogCachePath,
  type ModelCatalog,
  type ModelCatalogOptions,
} from "./catalog.ts";
import { MODEL_CATALOG_SCHEMA, containsBrace, packCatalog, trimModelsDevCatalog, type ModelCatalogDocument } from "./trim.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-model-catalog-")));
  dirs.push(dir);
  return dir;
}

const rawModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, tool_call: true, reasoning: false, attachment: false,
  modalities: { input: ["text"], output: ["text"] }, release_date: "2026-01-01", limit: { context: 128_000, output: 4096 }, ...extra,
});

/** A models.dev-shaped catalog with one provider whose single model is `model`. */
const rawCatalog = (providerId: string, model: string, extra: Record<string, unknown> = {}) => ({
  [providerId]: {
    id: providerId, name: providerId, env: ["DEMO_API_KEY"], npm: "@ai-sdk/openai-compatible",
    api: `https://api.${providerId}.example/v1`, models: { [model]: rawModel(model) }, ...extra,
  },
});

function doc(raw: unknown, updatedAt: number, etag?: string): ModelCatalogDocument {
  return {
    schema: MODEL_CATALOG_SCHEMA,
    updatedAt: new Date(updatedAt).toISOString(),
    source: { name: "models.dev", url: MODELS_DEV_URL, ...(etag ? { etag } : {}) },
    providers: packCatalog(trimModelsDevCatalog(raw)),
  };
}

function writeCache(dataDir: string, value: ModelCatalogDocument | string): string {
  const path = modelCatalogCachePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

interface Harness {
  store: ModelCatalogStore;
  dataDir: string;
  fetch: ReturnType<typeof vi.fn>;
  logs: string[];
}

function harness(options: Partial<ModelCatalogOptions> & { snapshot?: ModelCatalogDocument | null } = {}): Harness {
  const dataDir = options.dataDir ?? tempDir();
  const logs: string[] = [];
  const fetchMock = vi.fn(async () => { throw new TypeError("fetch failed: offline"); });
  const snapshot = options.snapshot === undefined ? doc(rawCatalog("snap", "snap-model"), NOW - 10 * 24 * HOUR) : options.snapshot;
  const store = new ModelCatalogStore({
    env: {},
    openCodeCachePath: null,
    now: () => NOW,
    log: (line) => logs.push(line),
    fetch: fetchMock as unknown as typeof fetch,
    readSnapshot: () => snapshot === null ? undefined : JSON.stringify(snapshot),
    ...options,
    dataDir,
  });
  return { store, dataDir, fetch: fetchMock, logs };
}

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...init.headers }, ...init });

const modelIds = (catalog: ModelCatalog) => Object.values(catalog.providers).flatMap((provider) => Object.keys(provider.models).map((model) => `${provider.id}/${model}`));

describe("bundled snapshot", () => {
  it("loads the shipped snapshot beside the module", () => {
    const store = new ModelCatalogStore({ dataDir: tempDir(), env: {}, openCodeCachePath: null, log: () => {} });
    const catalog = store.get();
    expect(catalog.origin).toBe("snapshot");
    expect(catalog.updatedAt).toBe("2026-09-30T05:32:26.000Z");
    expect(Object.keys(catalog.providers).length).toBeGreaterThan(200);
    expect(catalog.providers.openrouter?.env).toEqual(["OPENROUTER_API_KEY"]);
    expect(catalog.providers.openrouter?.models["anthropic/claude-sonnet-4.5"]).toMatchObject({ id: "anthropic/claude-sonnet-4.5", tool_call: true });
    // Providers whose base URL is a template never make it in.
    for (const id of ["cloudflare-workers-ai", "databricks", "neon", "snowflake-cortex"]) expect(catalog.providers[id]).toBeUndefined();
    expect(containsBrace(catalog.providers)).toBe(false);
  });

  it("is found under model-catalog/ beside the bundled server", async () => {
    const out = tempDir();
    await build({
      entryPoints: [join(import.meta.dirname, "catalog.ts")],
      bundle: true, platform: "node", target: "node20", format: "esm", outdir: out, logLevel: "silent",
    });
    mkdirSync(join(out, "model-catalog"));
    copyFileSync(join(import.meta.dirname, "models-dev.snapshot.json"), join(out, "model-catalog", "models-dev.snapshot.json"));
    const bundled = await import(pathToFileURL(join(out, "catalog.js")).href) as typeof import("./catalog.ts");
    const catalog = new bundled.ModelCatalogStore({ dataDir: tempDir(), env: {}, openCodeCachePath: null, log: () => {} }).get();
    expect(catalog.origin).toBe("snapshot");
    expect(catalog.providers.deepseek).toBeDefined();
    // The OpenCode licence notice survives bundling.
    expect(readFileSync(join(out, "catalog.js"), "utf8")).toContain("Copyright (c) 2025 opencode");
  });
});

describe("offline fallback", () => {
  it("keeps serving the snapshot when models.dev cannot be reached, and says so only in the log", async () => {
    const { store, fetch, logs, dataDir } = harness();
    await expect(store.refresh()).resolves.toBe("failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.get()).toMatchObject({ origin: "snapshot" });
    expect(modelIds(store.get())).toEqual(["snap/snap-model"]);
    expect(logs.some((line) => line.includes("could not refresh from models.dev"))).toBe(true);
    expect(existsSync(modelCatalogCachePath(dataDir))).toBe(false);
  });

  it("keeps an older cache byte for byte when a refresh fails", async () => {
    const { store, dataDir } = harness();
    const path = writeCache(dataDir, doc(rawCatalog("cached", "c1"), NOW - 3 * 24 * HOUR, '"v1"'));
    const before = readFileSync(path, "utf8");
    await expect(store.refresh()).resolves.toBe("failed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(store.get().origin).toBe("cache");
  });

  it("returns an empty catalog, not an error, when there is nothing at all", () => {
    const { store, logs } = harness({ snapshot: null });
    expect(store.get()).toEqual({ origin: "empty", updatedAt: new Date(0).toISOString(), providers: {} });
    expect(store.get().providers["constructor"]).toBeUndefined();
    expect(logs.some((line) => line.includes("snapshot is missing"))).toBe(true);
  });
});

describe("choosing a source", () => {
  it("prefers our cache when it is newer than the snapshot", () => {
    const { store, dataDir } = harness();
    writeCache(dataDir, doc(rawCatalog("cached", "c1"), NOW - HOUR));
    expect(store.get().origin).toBe("cache");
    expect(modelIds(store.get())).toEqual(["cached/c1"]);
  });

  it("lets a newer snapshot beat an older cache", () => {
    const { store, dataDir } = harness({ snapshot: doc(rawCatalog("snap", "s1"), NOW - HOUR) });
    writeCache(dataDir, doc(rawCatalog("cached", "c1"), NOW - 5 * HOUR));
    expect(store.get().origin).toBe("snapshot");
  });

  it("keeps our cache over a snapshot of the same age", () => {
    const { store, dataDir } = harness({ snapshot: doc(rawCatalog("snap", "s1"), NOW - HOUR) });
    writeCache(dataDir, doc(rawCatalog("cached", "c1"), NOW - HOUR));
    expect(store.get().origin).toBe("cache");
  });

  it("uses OpenCode's cache only when it is newer, and filters it the same way", () => {
    const openCodeDir = tempDir();
    const openCodeCachePath = join(openCodeDir, "models.json");
    writeFileSync(openCodeCachePath, JSON.stringify({
      ...rawCatalog("oc", "fresh-model"),
      evil: { id: "evil", name: "Evil", env: [], api: "https://${EVIL}/v1", models: { m: rawModel("m") } },
      router: { id: "router", name: "Router", env: [], models: { "x{env:OMB_MP_KEY_OTHER}": rawModel("x{env:OMB_MP_KEY_OTHER}"), ok: rawModel("ok") } },
    }));
    utimesSync(openCodeCachePath, (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);

    const newer = harness({ openCodeCachePath });
    writeCache(newer.dataDir, doc(rawCatalog("cached", "c1"), NOW - 2 * HOUR));
    expect(newer.store.get().origin).toBe("opencode");
    expect(modelIds(newer.store.get()).sort()).toEqual(["oc/fresh-model", "router/ok"]);
    expect(newer.logs.some((line) => line.includes("left out 2 opencode catalog entries"))).toBe(true);
    // Read only: never rewritten or removed.
    expect(existsSync(openCodeCachePath)).toBe(true);

    const older = harness({ openCodeCachePath });
    writeCache(older.dataDir, doc(rawCatalog("cached", "c1"), NOW - HOUR / 2));
    expect(older.store.get().origin).toBe("cache");
  });

  it("removes a corrupt cache and falls back", () => {
    const { store, dataDir, logs } = harness();
    const path = writeCache(dataDir, "{ not json");
    expect(store.get().origin).toBe("snapshot");
    expect(existsSync(path)).toBe(false);
    expect(logs.some((line) => line.includes("removed an unreadable catalog cache"))).toBe(true);
  });

  it("skips a readable cache that holds no usable providers", () => {
    const { store, dataDir } = harness();
    writeCache(dataDir, { schema: MODEL_CATALOG_SCHEMA, updatedAt: new Date(NOW).toISOString(), source: { name: "models.dev", url: MODELS_DEV_URL }, providers: {} });
    expect(store.get().origin).toBe("snapshot");
  });
});

describe("refresh", () => {
  it("does not fetch while the cache is under 24 hours old", async () => {
    const { store, dataDir, fetch } = harness();
    writeCache(dataDir, doc(rawCatalog("cached", "c1"), NOW - 23 * HOUR));
    await expect(store.refresh()).resolves.toBe("fresh");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches once the cache is over 24 hours old, or when forced", async () => {
    const stale = harness();
    writeCache(stale.dataDir, doc(rawCatalog("cached", "c1"), NOW - 25 * HOUR));
    await stale.store.refresh();
    expect(stale.fetch).toHaveBeenCalledTimes(1);

    const forced = harness();
    writeCache(forced.dataDir, doc(rawCatalog("cached", "c1"), NOW - HOUR));
    await forced.store.refresh({ force: true });
    expect(forced.fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a cache stamped in the future as stale", async () => {
    const { store, dataDir, fetch } = harness();
    writeCache(dataDir, doc(rawCatalog("cached", "c1"), NOW + 2 * HOUR));
    await store.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("writes a trimmed, brace-free cache with the ETag, atomically", async () => {
    const { store, dataDir, fetch, logs } = harness();
    fetch.mockResolvedValueOnce(jsonResponse({
      ...rawCatalog("live", "l1"),
      evil: { id: "evil", name: "Evil", env: [], models: { "y{file:~/.ssh/id_rsa}": rawModel("y{file:~/.ssh/id_rsa}"), fine: rawModel("fine") } },
    }, { headers: { etag: '"abc"' } }));
    await expect(store.refresh()).resolves.toBe("updated");

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://models.dev/api.json");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("if-none-match")).toBeNull();

    const path = modelCatalogCachePath(dataDir);
    const written = JSON.parse(readFileSync(path, "utf8")) as ModelCatalogDocument;
    expect(written).toMatchObject({ schema: MODEL_CATALOG_SCHEMA, updatedAt: new Date(NOW).toISOString(), source: { etag: '"abc"' } });
    expect(Object.keys(written.providers.evil!.models)).toEqual(["fine"]);
    expect(containsBrace(written.providers)).toBe(false);
    expect(readdirSync(dirname(path))).toEqual(["models-dev.json"]);
    expect(store.get()).toMatchObject({ origin: "cache" });
    expect(modelIds(store.get()).sort()).toEqual(["evil/fine", "live/l1"]);
    expect(logs.some((line) => line.includes("left out 1 entries"))).toBe(true);
  });

  it("revalidates with If-None-Match and only renews the date on 304", async () => {
    const { store, dataDir, fetch } = harness();
    const path = writeCache(dataDir, doc(rawCatalog("cached", "c1"), NOW - 30 * HOUR, '"v7"'));
    fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(store.refresh()).resolves.toBe("not-modified");
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("if-none-match")).toBe('"v7"');
    const renewed = JSON.parse(readFileSync(path, "utf8")) as ModelCatalogDocument;
    expect(renewed.updatedAt).toBe(new Date(NOW).toISOString());
    expect(renewed.source.etag).toBe('"v7"');
    expect(Object.keys(renewed.providers)).toEqual(["cached"]);
    await expect(store.refresh()).resolves.toBe("fresh");
  });

  it("never replaces a good cache with an empty, invalid, failed or oversized reply", async () => {
    const cacheText = JSON.stringify(doc(rawCatalog("cached", "c1"), NOW - 30 * HOUR));
    const cap = cacheText.length + 16;
    // A valid catalog, padded past the cap: only the cap stops it.
    const big = JSON.stringify(rawCatalog("huge", "h1", { description: "p".repeat(cap) }));
    const stream = () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } });
    const replies: Array<[string, () => Response]> = [
      ["no providers", () => jsonResponse({})],
      ["not JSON", () => new Response("<html>", { status: 200 })],
      ["server error", () => new Response("{}", { status: 500 })],
      ["declared too large", () => new Response(big, { status: 200, headers: { "content-length": String(big.length) } })],
      ["streamed too large", () => new Response(stream(), { status: 200 })],
      ["304 without an ETag sent", () => new Response(null, { status: 304 })],
    ];
    for (const [label, reply] of replies) {
      const { store, dataDir, fetch } = harness({ maxBytes: cap });
      const path = writeCache(dataDir, cacheText);
      fetch.mockResolvedValueOnce(reply());
      await expect(store.refresh(), label).resolves.toBe("failed");
      expect(readFileSync(path, "utf8"), label).toBe(cacheText);
    }
  });

  it("does not start reading a body declared larger than the cap", async () => {
    const { store, fetch } = harness({ maxBytes: 1024 });
    let pulled = false;
    const body = new ReadableStream({ pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } }, { highWaterMark: 0 });
    fetch.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-length": String(50 * 1024 * 1024) } }));
    await expect(store.refresh()).resolves.toBe("failed");
    expect(pulled).toBe(false);
  });

  it("gives up after the timeout", async () => {
    const { store, fetch, logs } = harness({ timeoutMs: 20 });
    fetch.mockImplementationOnce(async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(store.refresh()).resolves.toBe("failed");
    expect(logs.some((line) => line.includes("did not answer in time"))).toBe(true);
  });

  it("shares one request between concurrent refreshes", async () => {
    const { store, fetch } = harness();
    let release!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = store.refresh();
    const second = store.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(jsonResponse(rawCatalog("live", "l1")));
    await expect(Promise.all([first, second])).resolves.toEqual(["updated", "updated"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is switched off by the environment and on managed or hosted installs", async () => {
    const byEnv = harness({ env: { [CATALOG_DISABLE_ENV]: "1" } });
    await expect(byEnv.store.refresh({ force: true })).resolves.toBe("disabled");
    expect(byEnv.fetch).not.toHaveBeenCalled();
    const managed = harness({ fetchDisabled: true });
    await expect(managed.store.refresh({ force: true })).resolves.toBe("disabled");
    expect(managed.fetch).not.toHaveBeenCalled();
    expect(managed.store.get().origin).toBe("snapshot");
  });
});

describe("catalogEntries", () => {
  const catalog = (providers: Record<string, unknown>): ModelCatalog =>
    ({ origin: "cache", updatedAt: new Date(NOW).toISOString(), providers: trimModelsDevCatalog(providers) });

  it("lists recommended presets first, in order, then the rest by name", () => {
    const entries = catalogEntries(catalog({
      ...rawCatalog("zeta", "z1"),
      ...rawCatalog("alpha", "a1"),
      ...rawCatalog("openrouter", "or1"),
    }));
    const recommended = entries.filter((entry) => entry.recommended !== undefined).map((entry) => entry.id);
    expect(recommended.slice(0, 5)).toEqual(["openrouter", "fireworks-ai", "deepseek", "cline-pass", "cline-credits"]);
    expect(entries.findIndex((entry) => entry.id === "alpha")).toBeLessThan(entries.findIndex((entry) => entry.id === "zeta"));
    expect(entries.findIndex((entry) => entry.id === "alpha")).toBeGreaterThan(entries.findIndex((entry) => entry.id === "cerebras"));
    expect(entries.find((entry) => entry.id === "openrouter")).toMatchObject({ catalogId: "openrouter", modelCount: 1, env: ["DEMO_API_KEY"] });
    // A preset models.dev does not list is still offered.
    expect(entries.find((entry) => entry.id === "cline-credits")).toMatchObject({
      label: "Cline (credits)", env: ["CLINE_API_KEY"], api: "https://api.cline.bot/api/v1", modelCount: 0,
    });
    expect(entries.find((entry) => entry.id === "cline-credits")?.catalogId).toBeUndefined();
  });

  it("keeps a preset's pinned base URL whatever the catalog says", () => {
    const entries = catalogEntries(catalog({
      ...rawCatalog("openrouter", "or1", { api: "https://evil.example/api/v1" }),
      ...rawCatalog("minimax", "mm1", { npm: "@ai-sdk/anthropic", api: "https://api.minimax.io/anthropic/v1" }),
    }));
    expect(entries.find((entry) => entry.id === "openrouter")?.api).toBe("https://openrouter.ai/api/v1");
    expect(entries.find((entry) => entry.id === "minimax")?.api).toBe("https://api.minimax.io/v1");
  });

  it("pairs each preset's pinned address with an SDK package that speaks to it", () => {
    const npm = (entries: ReturnType<typeof catalogEntries>, id: string) => entries.find((entry) => entry.id === id)?.npm;
    const entries = catalogEntries(catalog({
      ...rawCatalog("minimax", "mm1", { npm: "@ai-sdk/anthropic", api: "https://api.minimax.io/anthropic/v1" }),
      ...rawCatalog("openrouter", "or1", { npm: "@openrouter/ai-sdk-provider", api: "https://openrouter.ai/api/v1" }),
      ...rawCatalog("groq", "g1", { npm: "@ai-sdk/groq", api: undefined }),
      ...rawCatalog("fireworks-ai", "fw1", { npm: "@ai-sdk/anthropic", api: "https://api.fireworks.ai/inference" }),
    }));
    // MiniMax: models.dev's package is for its Anthropic endpoint, not the pinned OpenAI one.
    expect(npm(entries, "minimax")).toBe("@ai-sdk/openai-compatible");
    // Kept when it describes the pinned address, or the SDK's own default address.
    expect(npm(entries, "openrouter")).toBe("@openrouter/ai-sdk-provider");
    expect(npm(entries, "groq")).toBe("@ai-sdk/groq");
    // A catalog that moves a preset to another endpoint does not move the package.
    expect(npm(entries, "fireworks-ai")).toBe("@ai-sdk/openai-compatible");
    // MiniMax's row pins the package even if models.dev pairs its OpenAI address with the Anthropic SDK.
    const paired = catalogEntries(catalog(rawCatalog("minimax", "mm1", { npm: "@ai-sdk/anthropic", api: "https://api.minimax.io/v1" })));
    expect(npm(paired, "minimax")).toBe("@ai-sdk/openai-compatible");
  });

  it("merges the bundled snapshot with every preset", () => {
    const store = new ModelCatalogStore({ dataDir: tempDir(), env: {}, openCodeCachePath: null, log: () => {} });
    const entries = catalogEntries(store.get());
    expect(entries.length).toBeGreaterThan(200);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.filter((entry) => entry.recommended !== undefined)).toHaveLength(13);
    for (const entry of entries) if (entry.doc) expect(entry.doc.startsWith("https://")).toBe(true);
    expect(entries.find((entry) => entry.id === "minimax")).toMatchObject({ npm: "@ai-sdk/openai-compatible", api: "https://api.minimax.io/v1" });
  });
});
