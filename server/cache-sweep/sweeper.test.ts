// The cache cap's rules that hold on every system: the switch, the numbers, the state file, which processes count as
// using a root, and that nothing is ever walked or deleted off Linux. What it deletes, and that it never leaves a root,
// is in sweeper.linux.test.ts and tree.linux.test.ts. Every path lives under each test's own temporary folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_TAG, CACHE_TAG_FILE, TOOL_CACHES, toolCacheRoot } from "../bot-box/tool-caches.ts";
import type { StorageReport } from "../perf/disk-usage.ts";
import { requiredScope } from "../request-auth.ts";
import { CACHES_CLEAR_PATH, CACHES_PATH, createCachesRoutes } from "../routes/caches.ts";
import { PASS } from "../routes/table.ts";
import { withCacheCounters } from "./host.ts";
import { rootsInUse } from "./in-use.ts";
import { GIB, capBytes, cacheSweepOn, parseSize } from "./limits.ts";
import { CACHE_SWEEP_STATE, CacheSweepOff, createCacheSweeper, parseState, type CacheSweeperDeps } from "./sweeper.ts";
import { anchoredSupported } from "./tree.ts";
import { TOOL_UNITS, expectedRoots } from "./units.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix = "omb-cache-sweep-") => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

function fixture() {
  const root = scratch();
  const home = join(root, "home"), dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const tools = toolCacheRoot(home);
  mkdirSync(join(tools, "pip"), { recursive: true });
  writeFileSync(join(tools, CACHE_TAG_FILE), CACHE_TAG);
  writeFileSync(join(tools, "pip", "wheel"), "x".repeat(10_000));
  return { root, home, dataDir, tools };
}

const ON = { OMB_CLOUD_ROLE: "home", OMB_CACHE_SWEEP: "on" };

function sweeper(f: ReturnType<typeof fixture>, overrides: Partial<CacheSweeperDeps> = {}) {
  const lines: string[] = [];
  const made = createCacheSweeper({
    dataDir: f.dataDir, home: f.home, env: ON, tools: () => true, audienceHomes: () => [], keep: () => [],
    volume: async () => ({ total: 100 * GIB, free: 1 * GIB }), inUse: async () => new Set(),
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
});

describe("what may ever be removed", () => {
  it("only whole tool folders the box routes a tool to, by fixed name, and never a browser's", () => {
    const routed = new Set(TOOL_CACHES.map((cache) => cache.folder));
    for (const name of TOOL_UNITS) expect(routed.has(name), name).toBe(true);
    for (const name of TOOL_UNITS) expect(name).not.toMatch(/playwright|puppeteer|chrom|browser|mcp/i);
    for (const name of ["go-mod", "go-build", "corepack"]) expect(TOOL_UNITS).not.toContain(name);
  });

  it("the tools' roots only while their folders are in use (the switch and a live box); the app's own always", () => {
    const input = { home: "/data", dataDir: "/data/.openmausbot", audienceHomes: ["/data/.openmausbot/engine-homes/member-a"] };
    expect(expectedRoots({ ...input, tools: false }).map((root) => root.group)).toEqual(["app"]);
    expect(expectedRoots({ ...input, tools: true }).filter((root) => root.group === "tools")).toHaveLength(2);
  });

  it("off Linux nothing is walked or deleted", () => {
    expect(anchoredSupported("linux")).toBe(true);
    for (const platform of ["darwin", "win32", "freebsd"] as const) expect(anchoredSupported(platform)).toBe(false);
  });

  it("where it cannot delete by open folders, every pass and every clear removes nothing", async () => {
    const f = fixture();
    const { made, lines } = sweeper(f, { supported: () => false });
    made.start(() => false);
    made.stop();
    expect(await made.sweep()).toEqual({ skipped: "unsupported" });
    expect(await made.emergency()).toEqual({ skipped: "unsupported" });
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 0, unsupported: true });
    expect(readFileSync(join(f.tools, "pip", "wheel"), "utf8")).toHaveLength(10_000);
    expect(lines.filter((line) => line.includes("needs Linux"))).toHaveLength(1);
  });
});

describe("switch off: nothing at all", () => {
  it("making it reads nothing; off, start reads nothing, starts no timer, and a real clear is refused", async () => {
    const f = fixture();
    writeFileSync(join(f.dataDir, CACHE_SWEEP_STATE), JSON.stringify({ cleared: { count: 7 } }));
    const reads: string[] = [];
    const readText = async (path: string) => { reads.push(path); return readFileSync(path, "utf8"); };
    const off = sweeper(f, { env: { OMB_CLOUD_ROLE: "home" }, readText });
    off.made.start(() => false);
    await new Promise((done) => setImmediate(done));
    expect(reads).toEqual([]);
    expect(off.lines).toEqual([]);
    expect(off.made.counters()).toBeNull();
    expect(await off.made.sweep()).toEqual({ skipped: "off" });
    expect(await off.made.emergency()).toEqual({ skipped: "off" });
    await expect(off.made.clearCaches({ dryRun: false })).rejects.toBeInstanceOf(CacheSweepOff);
    expect(existsSync(join(f.tools, "pip", "wheel"))).toBe(true);
    // On, making it still reads nothing: the counters come once it is started (after the server answers), read once.
    const on = sweeper(f, { readText });
    await new Promise((done) => setImmediate(done));
    expect(reads).toEqual([]);
    expect(on.made.counters()).toBeNull();
    on.made.start(() => true);
    on.made.stop();
    await on.made.report();
    expect(on.made.counters()).toMatchObject({ cacheCleared: { count: 7 } });
    expect(reads).toEqual([join(f.dataDir, CACHE_SWEEP_STATE)]);
  });

  it("the storage report is unchanged until the counters are read", () => {
    const report = { v: 1, at: 1 } as unknown as StorageReport;
    expect(withCacheCounters(report, { counters: () => null })).toBe(report);
    expect(withCacheCounters(null, { counters: () => ({ cacheCleared: { count: 1, bytes: 2, entries: 1, at: 3, reason: "r" }, emergency: { count: 0, bytes: 0, at: null } }) })).toBeNull();
    expect(withCacheCounters(report, { counters: () => ({ cacheCleared: { count: 1, bytes: 2, entries: 1, at: 3, reason: "r" }, emergency: { count: 0, bytes: 0, at: null } }) })).toMatchObject({ caches: { cacheCleared: { count: 1 } } });
  });
});

describe("the state file", () => {
  it("any shape reads as counters, never an error", () => {
    for (const text of ['{"measured":null}', '{"cleared":null}', "[1,2]", "null", '{"emergency":{"at":"x"}}', "not json", "", '{"lastSweep":{"at":"x"}}', '{"cleared":{"count":-1,"bytes":"9"}}']) {
      const state = parseState(text);
      expect(state.cleared).toEqual({ count: 0, bytes: 0, entries: 0, at: null, reason: null });
      expect(state.emergency.at).toBeNull();
      expect(state.lastSweep).toBeNull();
    }
    expect(parseState('{"cleared":{"count":2,"bytes":5,"entries":1,"at":9,"reason":"r"},"lastSweep":{"at":4,"roots":{}}}')).toMatchObject({ cleared: { count: 2, bytes: 5, at: 9, reason: "r" }, lastSweep: { at: 4 } });
  });

  it("a broken state file does not stop a pass or the report", async () => {
    const f = fixture();
    writeFileSync(join(f.dataDir, CACHE_SWEEP_STATE), '{"measured":null,"cleared":null}');
    const { made } = sweeper(f, { supported: () => false });
    expect(await made.report()).toMatchObject({ on: true, cacheCleared: { count: 0 } });
  });
});

describe("which roots a live process uses (/proc)", () => {
  /** A folder shaped like /proc: one process per entry, with its links, maps and environment. */
  function proc(processes: Record<string, { parent?: number; cwd?: string; exe?: string; fds?: string[]; maps?: string; environ?: Record<string, string> }>) {
    const dir = scratch("omb-proc-");
    for (const [pid, info] of Object.entries(processes)) {
      const at = join(dir, pid);
      mkdirSync(join(at, "fd"), { recursive: true });
      // The name may hold spaces and parentheses; the parent is the field after the last one.
      writeFileSync(join(at, "stat"), `${pid} (a (b) c) S ${info.parent ?? 1} ${pid} 0 0 -1`);
      symlinkSync(info.cwd ?? "/", join(at, "cwd"));
      symlinkSync(info.exe ?? "/usr/bin/node", join(at, "exe"));
      symlinkSync("/", join(at, "root"));
      (info.fds ?? []).forEach((target, fd) => symlinkSync(target, join(at, "fd", String(fd))));
      writeFileSync(join(at, "maps"), info.maps ?? "");
      writeFileSync(join(at, "environ"), Object.entries(info.environ ?? {}).map(([name, value]) => `${name}=${value}`).join("\0"));
    }
    return dir;
  }
  const personal = "/data/cache", member = "/data/.openmausbot/engine-homes/member-a/cache";

  it.skipIf(process.platform === "win32")("a process whose working folder, program, open file, mapped file or environment names a path in a root uses it", async () => {
    const cases: Array<[string, Parameters<typeof proc>[0][string]]> = [
      ["cwd", { cwd: `${personal}/uv/archive-v0/abc` }],
      ["exe", { exe: `${personal}/npm/_npx/1a2b/node_modules/.bin/server` }],
      ["fd", { fds: ["/dev/null", `${personal}/pip/http-v2/x`] }],
      ["maps", { maps: `7f00-7f01 r-xp 0 00:1 2 ${personal}/uv/archive-v0/abc/lib.so (deleted)\n` }],
      ["environ", { environ: { npm_config_cache: `${personal}/npm`, HOME: "/data" } }],
      ["PATH", { environ: { PATH: `/usr/bin:${personal}/uv/archive-v0/abc/bin` } }],
    ];
    for (const [name, info] of cases) expect([...await rootsInUse([personal, member], { proc: proc({ 100: info }), self: 1 })], name).toEqual([personal]);
  });

  it.skipIf(process.platform === "win32")("not: a process elsewhere, a folder whose name only starts the same, the server itself, one the server did not start", async () => {
    const dir = proc({
      100: { cwd: "/data/projects/site", environ: { HOME: "/data", PATH: "/usr/bin" } },
      101: { cwd: "/data/cache-old/x", environ: { X: "/data/cachefile" } },
      102: { cwd: `${personal}/npm` },
      103: { parent: 50, cwd: `${member}/uv` },
    });
    expect([...await rootsInUse([personal, member], { proc: dir, self: 102 })]).toEqual([]);
    expect([...await rootsInUse([personal, member], { proc: dir, self: 1 })]).toEqual([personal]);
    // A grandchild (a box's process, or what a bot started inside it) counts.
    const tree = proc({ 200: { parent: 1 }, 201: { parent: 200 }, 202: { parent: 201, cwd: `${member}/pip` } });
    expect([...await rootsInUse([member], { proc: tree, self: 1 })]).toEqual([member]);
    expect([...await rootsInUse([member], { proc: tree, self: 7 })]).toEqual([]);
  });

  it("no /proc to read: every root counts as used", async () => {
    expect([...await rootsInUse([personal], { proc: join(scratch(), "missing") })]).toEqual([personal]);
  });
});

describe("the admin API", () => {
  const call = async (made: Parameters<typeof createCachesRoutes>[0], method: string, path: string, body?: unknown) => {
    const sent: Array<{ status: number; body: unknown }> = [];
    const answer = await createCachesRoutes(made)({
      req: {} as never, res: { setHeader() {} } as never, url: new URL(`http://127.0.0.1${path}`), path, method, auth: {} as never,
      json: ((_res: unknown, status: number, payload: unknown) => { sent.push({ status, body: payload }); }) as never,
      readBody: (async () => { if (body instanceof Error) throw body; return body; }) as never,
    });
    return answer === PASS ? "pass" : sent[0];
  };

  it("is not there with the switch off, or off a Cloud home: the routes pass, as if absent", async () => {
    const f = fixture();
    for (const env of [{}, { OMB_CLOUD_ROLE: "home" }, { OMB_CACHE_SWEEP: "on" }]) {
      const made = sweeper(f, { env }).made;
      expect(await call(made, "GET", CACHES_PATH)).toBe("pass");
      expect(await call(made, "POST", CACHES_CLEAR_PATH, { dryRun: false })).toBe("pass");
    }
    expect(existsSync(join(f.tools, "pip", "wheel"))).toBe(true);
  });

  it("needs the admin scope for both paths", () => {
    expect(requiredScope("GET", CACHES_PATH)).toBe("admin");
    expect(requiredScope("POST", CACHES_CLEAR_PATH)).toBe("admin");
  });

  it("POST is a dry run unless the body says dryRun false, and a broken body is a dry run", async () => {
    const asked: Array<{ dryRun?: boolean; scope?: string }> = [];
    const fake = { available: () => true, report: async () => ({}) as never, clearCaches: async (options: { dryRun?: boolean; scope?: "tools" | "app" | "all" } = {}) => { asked.push(options); return { dryRun: options.dryRun !== false } as never; } };
    await call(fake, "POST", CACHES_CLEAR_PATH, {});
    await call(fake, "POST", CACHES_CLEAR_PATH, new Error("bad json"));
    await call(fake, "POST", CACHES_CLEAR_PATH, { dryRun: "false", scope: "nope" });
    await call(fake, "POST", CACHES_CLEAR_PATH, { dryRun: false, scope: "tools" });
    expect(asked).toEqual([{ dryRun: true, scope: "all" }, { dryRun: true, scope: "all" }, { dryRun: true, scope: "all" }, { dryRun: false, scope: "tools" }]);
  });
});
