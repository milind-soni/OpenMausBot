// The cache cap on fixtures that live only under each test's own temporary folder: the fake HOME, the data folder and
// every "outside" target too. Nothing here reads the real HOME or the environment.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { requiredScope } from "../request-auth.ts";
import { CACHES_CLEAR_PATH, CACHES_PATH, createCachesRoutes } from "../routes/caches.ts";
import { GIB, capBytes, cacheSweepOn, parseSize } from "./limits.ts";
import { createCacheSweeper, mountKeepsAtime, type CacheSweeperDeps } from "./sweeper.ts";
import { EVICTING_PREFIX, checkRoot, listUnits } from "./units.ts";

const DAY = 24 * 60 * 60_000;
// Ahead of the files' change times (which a test cannot set), so only the modification times set here decide.
const NOW = Date.now() + 30 * DAY;
const KB = 1024;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-cache-sweep-"));
  dirs.push(root);
  const home = join(root, "home"), dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  return { root, home, dataDir, tools: join(home, "cache"), app: join(dataDir, "cache") };
}

/** A file of `kb` KB whose folder chain up to `stop` is aged `daysOld` days before NOW. */
function put(path: string, kb: number, daysOld: number, stop: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(kb * KB, 1));
  const at = new Date(NOW - daysOld * DAY);
  for (let p = path; p.startsWith(stop) && p !== stop; p = dirname(p)) utimesSync(p, at, at);
}

const ON = { OMB_CLOUD_ROLE: "home", OMB_CACHE_SWEEP: "on" };

function sweeper(f: ReturnType<typeof fixture>, overrides: Partial<CacheSweeperDeps> = {}) {
  const lines: string[] = [];
  const made = createCacheSweeper({
    dataDir: f.dataDir, home: f.home, env: ON, tools: true, audienceHomes: () => [], keep: () => [],
    atimeKept: async () => false, volume: async () => ({ total: 100 * GIB, free: 50 * GIB }), now: () => NOW,
    pace: { entries: 1_000_000, yieldEvery: 50, pauseMs: 0 }, log: (line) => lines.push(line), ...overrides,
  });
  return { made, lines };
}

describe("limits", () => {
  it("the cap is the smaller of 10 GB and 15% of the volume, unless overridden", () => {
    expect(capBytes(10 * GIB)).toBe(Math.floor(1.5 * GIB));
    expect(capBytes(80 * GIB)).toBe(10 * GIB);
    expect(capBytes(80 * GIB, "4G")).toBe(4 * GIB);
    expect(capBytes(80 * GIB, "nonsense")).toBe(10 * GIB);
    expect(parseSize("512M")).toBe(512 * 1024 ** 2);
    expect(parseSize("2000")).toBe(2000);
    expect(parseSize("1.5GiB")).toBe(Math.floor(1.5 * GIB));
  });

  it("the switch is on only on a Cloud home that sets it", () => {
    expect(cacheSweepOn({})).toBe(false);
    expect(cacheSweepOn({ OMB_CACHE_SWEEP: "on" })).toBe(false);
    expect(cacheSweepOn({ OMB_CLOUD_ROLE: "home" })).toBe(false);
    expect(cacheSweepOn(ON)).toBe(true);
    expect(cacheSweepOn({ OMB_CLOUD_ROLE: "team", OMB_CACHE_SWEEP: "1" })).toBe(true);
  });

  it("reads whether the mount keeps access times from mountinfo: noatime does not, relatime does, off Linux no", async () => {
    const info = (options: string) => async () => `22 1 0:1 / / rw - ext4 /dev/a rw\n33 22 0:2 / /data ${options} - ext4 /dev/b rw\n`;
    expect(await mountKeepsAtime("/data/cache", info("rw,noatime"))).toBe(false);
    expect(await mountKeepsAtime("/data/cache", info("rw,relatime"))).toBe(true);
    expect(await mountKeepsAtime("/database", info("rw,noatime"))).toBe(true);
    expect(await mountKeepsAtime("/data", async () => { throw new Error("no /proc"); })).toBe(false);
  });
});

describe("the sweep", () => {
  it("keeps each root under its cap, removing the least recently used whole entries first", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "http-v2", "a"), 300, 9, f.tools);
    put(join(f.tools, "npm", "_npx", "aaaa", "node_modules", "x.js"), 200, 7, f.tools);
    put(join(f.tools, "npm", "_cacache", "content-v2", "b"), 200, 5, f.tools);
    put(join(f.tools, "uv", "wheels-v5", "c"), 200, 2, f.tools);
    const { made } = sweeper(f, { env: { ...ON, OMB_CACHE_CAP_TOOLS: `${260 * KB}` } });
    const result = await made.sweep();
    expect(result).toMatchObject({ groups: { tools: { cap: 260 * KB, removed: 3 } } });
    if ("groups" in result) expect(result.groups.tools!.bytes).toBeLessThanOrEqual(260 * KB);
    // Oldest first: pip (9 days), then the npx install (7), then npm's store (5); uv (2 days) stays.
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    expect(existsSync(join(f.tools, "npm", "_npx", "aaaa"))).toBe(false);
    expect(existsSync(join(f.tools, "npm", "_cacache"))).toBe(false);
    expect(existsSync(join(f.tools, "uv", "wheels-v5", "c"))).toBe(true);
    // A split folder itself, and the rename-aside folders, never remain as debris.
    expect(existsSync(join(f.tools, "npm"))).toBe(true);
    expect(readdirSync(f.tools).filter((name) => name.startsWith(EVICTING_PREFIX))).toEqual([]);
    expect((await made.report()).cacheCleared).toMatchObject({ count: 1, entries: 3 });
  });

  it("under the cap, removes nothing", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    expect(await sweeper(f).made.sweep()).toMatchObject({ groups: { tools: { removed: 0 } } });
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
  });

  it("never removes an entry changed in the last 30 minutes, though it is over the cap: a download in progress", async () => {
    const f = fixture();
    put(join(f.tools, "ms-playwright", "chromium-1140", "chrome"), 400, 20, f.tools);
    // The oldest folder, with one file just written into it.
    put(join(f.tools, "ms-playwright", "chromium-1140", "partial.zip"), 10, 1 / (24 * 60), f.tools);
    put(join(f.tools, "ms-playwright", "ffmpeg-1010", "ffmpeg"), 100, 3, f.tools);
    const { made } = sweeper(f, { env: { ...ON, OMB_CACHE_CAP_TOOLS: "1" } });
    await made.sweep();
    expect(existsSync(join(f.tools, "ms-playwright", "chromium-1140", "chrome"))).toBe(true);
    expect(existsSync(join(f.tools, "ms-playwright", "chromium-1140", "partial.zip"))).toBe(true);
    expect(existsSync(join(f.tools, "ms-playwright", "ffmpeg-1010"))).toBe(false);
  });

  it("removes only names it knows: anything else in a root is measured and left", async () => {
    const f = fixture();
    put(join(f.tools, "my-notes", "plan.md"), 50, 30, f.tools);
    put(join(f.tools, "huggingface", "token"), 1, 30, f.tools);
    put(join(f.tools, "huggingface", "hub", "models--org--m", "blobs", "x"), 50, 30, f.tools);
    put(join(f.tools, "huggingface", "hub", ".locks", "models--org--m", "l"), 1, 30, f.tools);
    put(join(f.app, "pre-update", "state.db"), 50, 30, f.app);
    put(join(f.app, "node-compile", "v22.1.0-x64-aaaa-1000", "e"), 50, 30, f.app);
    put(join(f.app, "node-compile", "v24.18.0-x64-bbbb-1000", "e"), 50, 30, f.app);
    const { made } = sweeper(f, { env: { ...ON, OMB_CACHE_CAP_TOOLS: "1", OMB_CACHE_CAP_APP: "1" }, keep: () => [join(f.app, "node-compile", "v24.18.0-x64-bbbb-1000")] });
    const result = await made.sweep();
    expect(existsSync(join(f.tools, "my-notes", "plan.md"))).toBe(true);
    expect(existsSync(join(f.tools, "huggingface", "token"))).toBe(true);
    expect(existsSync(join(f.tools, "huggingface", "hub", ".locks"))).toBe(true);
    expect(existsSync(join(f.tools, "huggingface", "hub", "models--org--m"))).toBe(false);
    expect(existsSync(join(f.app, "pre-update", "state.db"))).toBe(true);
    expect(existsSync(join(f.app, "node-compile", "v22.1.0-x64-aaaa-1000"))).toBe(false);
    // The running server's own compile cache folder.
    expect(existsSync(join(f.app, "node-compile", "v24.18.0-x64-bbbb-1000", "e"))).toBe(true);
    expect(result).toMatchObject({ groups: { tools: { unknown: 1 }, app: { unknown: 1 } } });
  });

  it("with Step 6 off, no tool cache folder is ours: only the app's own is swept", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 30, f.tools);
    put(join(f.app, "node-compile", "old", "e"), 100, 30, f.app);
    await sweeper(f, { tools: false, env: { ...ON, OMB_CACHE_CAP_TOOLS: "1", OMB_CACHE_CAP_APP: "1" } }).made.sweep();
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    expect(existsSync(join(f.app, "node-compile", "old"))).toBe(false);
  });

  it("switch off: nothing is ever deleted, by the sweep, the emergency pass or a clear", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 30, f.tools);
    const { made } = sweeper(f, { env: { OMB_CLOUD_ROLE: "home", OMB_CACHE_CAP_TOOLS: "1" }, volume: async () => ({ total: 100, free: 1 }) });
    expect(await made.sweep()).toEqual({ skipped: "off" });
    expect(await made.emergency()).toEqual({ skipped: "off" });
    await expect(made.clearCaches({ dryRun: false })).rejects.toThrow(/off/);
    expect((await made.clearCaches()).entries).toBe(1);
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    made.start(() => false);
    made.stop();
  });

  it("skips while a turn runs, and resumes the measurement where it stopped", async () => {
    const f = fixture();
    for (const name of ["pip", "uv", "bun", "go-build"]) put(join(f.tools, name, "x"), 100, 10, f.tools);
    const { made } = sweeper(f, { env: { ...ON, OMB_CACHE_CAP_TOOLS: "1" } });
    expect(await made.sweep(() => true)).toEqual({ skipped: "busy" });
    let calls = 0;
    // Busy from the third look (the first is the pass's own): one unit is measured and kept in the state file, then it stops.
    expect(await made.sweep(() => ++calls > 2)).toEqual({ skipped: "busy" });
    const state = JSON.parse(readFileSync(join(f.dataDir, "cache-sweep.json"), "utf8")) as { measured: Record<string, unknown> };
    expect(Object.keys(state.measured)).toHaveLength(1);
    // A new sweeper (a restart) goes on from there and finishes.
    const again = sweeper(f, { env: { ...ON, OMB_CACHE_CAP_TOOLS: "1" } }).made;
    expect(await again.sweep()).toMatchObject({ groups: { tools: { removed: 4 } } });
  });

  it("does not hold the event loop: other callbacks run while it walks", async () => {
    const f = fixture();
    for (let i = 0; i < 400; i++) put(join(f.tools, "pip", "http-v2", `f${i}`), 1, 10, f.tools);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 0);
    await sweeper(f, { pace: { entries: 100, yieldEvery: 10, pauseMs: 1 } }).made.sweep();
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("the emergency pass", () => {
  it("at 95% full empties the tools' cache folders (all but what is in use), counts it, and leaves the app's own", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 1, f.tools);
    put(join(f.tools, "npm", "_cacache", "b"), 100, 1, f.tools);
    put(join(f.tools, "uv", "now"), 10, 1 / (24 * 60), f.tools);
    put(join(f.app, "node-compile", "old", "e"), 100, 30, f.app);
    let free = 4 * GIB;
    const { made, lines } = sweeper(f, { volume: async () => ({ total: 100 * GIB, free }) });
    const result = await made.emergency();
    expect(result).toMatchObject({ entries: 2, recent: 1 });
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    expect(existsSync(join(f.tools, "npm", "_cacache"))).toBe(false);
    expect(existsSync(join(f.tools, "uv", "now"))).toBe(true);
    expect(existsSync(join(f.app, "node-compile", "old"))).toBe(true);
    expect(lines.some((line) => line.includes("96% full"))).toBe(true);
    const report = await made.report();
    expect(report.emergency).toMatchObject({ count: 1, at: NOW });
    expect(report.cacheCleared).toMatchObject({ count: 1, entries: 2, reason: "emergency: volume full", at: NOW });
    expect(report.cacheCleared.bytes).toBeGreaterThanOrEqual(200 * KB);
    // Still full: no second walk until the back-off has passed. With room, nothing.
    expect(await made.emergency()).toEqual({ skipped: "backoff" });
    free = 50 * GIB;
    expect(await sweeper(f, { volume: async () => ({ total: 100 * GIB, free }) }).made.emergency()).toEqual({ skipped: "room" });
  });
});

describe("clearCaches", () => {
  it("a dry run says what would go and deletes nothing; a real one removes exactly that", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 3, f.tools);
    put(join(f.tools, "go-mod", "m", "f"), 100, 3, f.tools);
    put(join(f.app, "node-compile", "old", "e"), 50, 3, f.app);
    const { made } = sweeper(f);
    const dry = await made.clearCaches();
    expect(dry).toMatchObject({ dryRun: true, entries: 3, files: expect.any(Number), recent: 0 });
    expect(dry.bytes).toBeGreaterThanOrEqual(250 * KB);
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    expect((await made.report()).cacheCleared.count).toBe(0);
    const tools = await made.clearCaches({ dryRun: false, scope: "tools" });
    expect(tools).toMatchObject({ dryRun: false, entries: 2 });
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    expect(existsSync(join(f.app, "node-compile", "old"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("removes Go's read-only module cache", async () => {
    const f = fixture();
    put(join(f.tools, "go-mod", "example.com", "m@v1", "f.go"), 1, 3, f.tools);
    const { chmodSync } = await import("node:fs");
    chmodSync(join(f.tools, "go-mod", "example.com", "m@v1"), 0o555);
    chmodSync(join(f.tools, "go-mod", "example.com"), 0o555);
    expect(await sweeper(f).made.clearCaches({ dryRun: false })).toMatchObject({ entries: 1 });
    expect(existsSync(join(f.tools, "go-mod"))).toBe(false);
  });
});

// Links: Windows makes them only with a privilege, and the sweeper runs only on a Linux Cloud home.
describe.skipIf(process.platform === "win32")("nothing outside the roots, ever", () => {
  it("a unit that is a link to a folder outside is refused, and the folder outside is untouched", async () => {
    const f = fixture();
    put(join(f.root, "outside", "precious.txt"), 10, 30, f.root);
    mkdirSync(f.tools, { recursive: true });
    symlinkSync(join(f.root, "outside"), join(f.tools, "pip"));
    const result = await sweeper(f).made.clearCaches({ dryRun: false });
    expect(result).toMatchObject({ entries: 0, kept: 1 });
    expect(existsSync(join(f.root, "outside", "precious.txt"))).toBe(true);
  });

  it("a link between the root and a unit (npm/_npx -> outside) is refused", async () => {
    const f = fixture();
    put(join(f.root, "outside", "abcd", "precious.txt"), 10, 30, f.root);
    mkdirSync(join(f.tools, "npm"), { recursive: true });
    symlinkSync(join(f.root, "outside"), join(f.tools, "npm", "_npx"));
    await sweeper(f).made.clearCaches({ dryRun: false });
    expect(existsSync(join(f.root, "outside", "abcd", "precious.txt"))).toBe(true);
  });

  it("a link inside an entry is removed as a link, never followed", async () => {
    const f = fixture();
    put(join(f.root, "outside", "precious.txt"), 10, 30, f.root);
    put(join(f.tools, "uv", "x"), 10, 30, f.tools);
    symlinkSync(join(f.root, "outside"), join(f.tools, "uv", "link"));
    expect(await sweeper(f).made.clearCaches({ dryRun: false })).toMatchObject({ entries: 1 });
    expect(existsSync(join(f.tools, "uv"))).toBe(false);
    expect(existsSync(join(f.root, "outside", "precious.txt"))).toBe(true);
  });

  it("a root that is a link, HOME itself, or holding the data folder is refused", async () => {
    const f = fixture();
    put(join(f.root, "elsewhere", "pip", "precious"), 10, 30, f.root);
    symlinkSync(join(f.root, "elsewhere"), f.tools);
    const { made, lines } = sweeper(f);
    const result = await made.clearCaches({ dryRun: false, scope: "tools" });
    expect(result.refusedRoots).toEqual([{ path: f.tools, reason: "a link" }]);
    expect(existsSync(join(f.root, "elsewhere", "pip", "precious"))).toBe(true);
    expect(lines.some((line) => line.includes("a link"))).toBe(true);
    expect(await checkRoot(f.home, [f.home, f.dataDir])).toEqual({ refused: "not a cache folder" });
    // A HOME named "cache": its own folder is the root's path only if something went wrong; refused.
    const odd = join(f.root, "cache");
    mkdirSync(join(odd, ".openmausbot"), { recursive: true });
    expect(await checkRoot(odd, [odd, join(odd, ".openmausbot")])).toEqual({ refused: "it is or holds HOME or the data folder" });
  });

  it("finishes an entry an interrupted removal renamed aside, and only that", async () => {
    const f = fixture();
    put(join(f.tools, `${EVICTING_PREFIX}abc`, "half"), 10, 30, f.tools);
    put(join(f.tools, ".omb-other", "keep"), 10, 30, f.tools);
    await sweeper(f).made.clearCaches({ dryRun: false });
    expect(existsSync(join(f.tools, `${EVICTING_PREFIX}abc`))).toBe(false);
    expect(existsSync(join(f.tools, ".omb-other", "keep"))).toBe(true);
    const { units } = await listUnits("tools", f.tools);
    expect(units.map((unit) => unit.name)).toEqual([".omb-other"]);
  });
});

describe("the admin API", () => {
  const call = async (made: ReturnType<typeof sweeper>["made"], method: string, path: string, body?: unknown) => {
    const sent: Array<{ status: number; body: unknown }> = [];
    await createCachesRoutes(made)({
      req: {} as never, res: { setHeader() {} } as never, url: new URL(`http://127.0.0.1${path}`), path, method, auth: {} as never,
      json: ((_res: unknown, status: number, payload: unknown) => { sent.push({ status, body: payload }); }) as never,
      readBody: (async () => { if (body instanceof Error) throw body; return body; }) as never,
    });
    return sent[0];
  };

  it("needs the admin scope for both paths", () => {
    expect(requiredScope("GET", CACHES_PATH)).toBe("admin");
    expect(requiredScope("POST", CACHES_CLEAR_PATH)).toBe("admin");
  });

  it("POST is a dry run unless the body says dryRun false; a broken body is a dry run; off refuses a real clear", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 10, 3, f.tools);
    const { made } = sweeper(f);
    expect(await call(made, "POST", CACHES_CLEAR_PATH, {})).toMatchObject({ status: 200, body: { dryRun: true, entries: 1 } });
    expect(await call(made, "POST", CACHES_CLEAR_PATH, new Error("bad json"))).toMatchObject({ status: 200, body: { dryRun: true } });
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    const off = sweeper(f, { env: { OMB_CLOUD_ROLE: "home" } }).made;
    expect(await call(off, "POST", CACHES_CLEAR_PATH, { dryRun: false })).toMatchObject({ status: 409 });
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    expect(await call(made, "POST", CACHES_CLEAR_PATH, { dryRun: false, scope: "tools" })).toMatchObject({ status: 200, body: { dryRun: false, entries: 1 } });
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    expect(await call(made, "GET", CACHES_PATH)).toMatchObject({ status: 200, body: { on: true, cacheCleared: { count: 1 } } });
  });
});
