// The cache cap on real folders, where it can delete: Linux (a Cloud home, CI's Linux runner). Elsewhere it skips, as the
// sweeper itself deletes nothing there. Every path, the "outside" ones too, lives under each test's own temporary folder.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_TAG, CACHE_TAG_FILE, toolCacheRoot } from "../bot-box/tool-caches.ts";
import { rootsInUse } from "./in-use.ts";
import { GIB } from "./limits.ts";
import { createCacheSweeper, type CacheSweeperDeps } from "./sweeper.ts";
import { Pacer, close } from "./tree.ts";
import { measureUnit, openRoot, removeUnit, type Unit } from "./units.ts";

const DAY = 24 * 60 * 60_000;
// Ahead of the files' change times (which a test cannot set), so only the modification times set here decide.
const NOW = Date.now() + 40 * DAY;
const KB = 1024;
const dirs: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) { spawnSync("chmod", ["-R", "u+w", dir]); rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-cache-sweep-")));
  dirs.push(root);
  const home = join(root, "home"), dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const tools = tagged(home);
  return { root, home, dataDir, tools, app: join(dataDir, "cache") };
}

/** A HOME's cache folder as the server makes it (bot-box/tool-caches.ts ensureToolCacheRoot). */
function tagged(home: string): string {
  const root = toolCacheRoot(home);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, CACHE_TAG_FILE), CACHE_TAG);
  return root;
}

/** A file of `kb` KB whose folders up to `stop` were last written `daysOld` days before NOW. */
function put(path: string, kb: number, daysOld: number, stop: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(kb * KB, 1));
  const at = new Date(NOW - daysOld * DAY);
  for (let p = path; p.startsWith(stop) && p !== stop; p = dirname(p)) utimesSync(p, at, at);
}

const ON = { OMB_CLOUD_ROLE: "home", OMB_CACHE_SWEEP: "on" };
const cmdline = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").slice(0, 200); } catch { return "?"; } };
const ROOMY = async () => ({ total: 100 * GIB, free: 50 * GIB });

function sweeper(f: ReturnType<typeof fixture>, overrides: Partial<CacheSweeperDeps> & { busy?: () => boolean } = {}) {
  const lines: string[] = [];
  const made = createCacheSweeper({
    dataDir: f.dataDir, home: f.home, env: ON, tools: () => true, audienceHomes: () => [], keep: () => [],
    volume: ROOMY, inUse: async () => new Set(), now: () => NOW,
    pace: { entries: 1_000_000, yieldEvery: 50, pauseMs: 0 }, log: (line) => lines.push(line), ...overrides,
  });
  // The server starts it once it answers (start-upkeep.ts); the timer itself is not needed here.
  made.start(overrides.busy ?? (() => false));
  made.stop();
  return { made, lines };
}
const withCap = (cap: string) => ({ env: { ...ON, OMB_CACHE_CAP_TOOLS: cap } });

describe.skipIf(process.platform !== "linux")("the cache cap on real folders", () => {
  it("keeps a root under its cap, removing whole folders, least recently written first", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "http", "a"), 200, 9, f.tools);
    put(join(f.tools, "npm", "_npx", "1a2b", "x"), 100, 7, f.tools);
    put(join(f.tools, "npm", "_cacache", "content", "y"), 200, 5, f.tools);
    put(join(f.tools, "uv", "wheels", "z"), 200, 2, f.tools);
    put(join(f.tools, "bun", "w"), 200, 1, f.tools);
    const { made } = sweeper(f, withCap("600K"));
    const result = await made.sweep();
    expect(result).toMatchObject({ busy: false });
    expect(readdirSync(f.tools).sort()).toEqual([CACHE_TAG_FILE, "bun", "uv"]);
    expect((await made.report()).cacheCleared).toMatchObject({ count: 1, entries: 2 });
  });

  it("under the cap, removes nothing; a folder written in the last 30 minutes stays even over it", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    expect(await sweeper(f).made.sweep()).toMatchObject({ busy: false });
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    put(join(f.tools, "uv", "old"), 100, 20, f.tools);
    put(join(f.tools, "uv", "new"), 100, 1 / (24 * 60), f.tools);
    await sweeper(f, withCap("250K")).made.sweep();
    expect(existsSync(join(f.tools, "uv", "old"))).toBe(true);
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
  });

  it("a folder alone over the cap is left and not counted, so the others are not emptied every pass", async () => {
    const f = fixture();
    put(join(f.tools, "uv", "big"), 600, 2, f.tools);
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    put(join(f.tools, "bun", "b"), 100, 1, f.tools);
    const { made, lines } = sweeper(f, withCap("300K"));
    await made.sweep();
    await made.sweep();
    for (const name of ["uv/big", "pip/a", "bun/b"]) expect(existsSync(join(f.tools, name)), name).toBe(true);
    expect(lines.filter((line) => line.includes("uv alone is"))).toHaveLength(1);
  });

  it("a person's own folder in the root is neither counted nor touched, by the sweep, the emergency pass or a clear", async () => {
    const f = fixture();
    put(join(f.tools, "my-scraped-data", "big.bin"), 2000, 30, f.tools);
    put(join(f.tools, "huggingface", "token"), 1, 30, f.tools);
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    await sweeper(f, withCap("300K")).made.sweep();
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    let full = true;
    const { made } = sweeper(f, { volume: async () => ({ total: 100, free: full ? 1 : 50 }) });
    await made.emergency();
    full = false;
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    put(join(f.tools, "uv", "a"), 100, 9, f.tools);
    await sweeper(f).made.clearCaches({ dryRun: false });
    expect(existsSync(join(f.tools, "uv"))).toBe(false);
    expect(existsSync(join(f.tools, "my-scraped-data", "big.bin"))).toBe(true);
    expect(existsSync(join(f.tools, "huggingface", "token"))).toBe(true);
  });

  it("a browser's folder is never removed: a Playwright MCP profile with its cookies and sign-ins stays", async () => {
    const f = fixture();
    put(join(f.tools, "ms-playwright", "chromium-1140", "chrome"), 300, 20, f.tools);
    put(join(f.tools, "ms-playwright", "mcp-chrome-1a2b3c", "Default", "Cookies"), 10, 20, f.tools);
    put(join(f.tools, "ms-playwright", "mcp-chromium-1a2b3c", "Default", "Login Data"), 10, 20, f.tools);
    put(join(f.tools, "puppeteer", "chrome", "x"), 300, 20, f.tools);
    await sweeper(f, withCap("1K")).made.sweep();
    await sweeper(f, { volume: async () => ({ total: 100, free: 1 }) }).made.emergency();
    await sweeper(f).made.clearCaches({ dryRun: false });
    expect(existsSync(join(f.tools, "ms-playwright", "mcp-chrome-1a2b3c", "Default", "Cookies"))).toBe(true);
    expect(existsSync(join(f.tools, "ms-playwright", "mcp-chromium-1a2b3c", "Default", "Login Data"))).toBe(true);
    expect(existsSync(join(f.tools, "ms-playwright", "chromium-1140", "chrome"))).toBe(true);
    expect(existsSync(join(f.tools, "puppeteer", "chrome", "x"))).toBe(true);
  });

  it("a cache folder the server did not make is never looked into, nor one that is a link", async () => {
    const f = fixture();
    rmSync(join(f.tools, CACHE_TAG_FILE));
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    const { made, lines } = sweeper(f);
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 0, refusedRoots: [{ path: f.tools }] });
    writeFileSync(join(f.tools, CACHE_TAG_FILE), "Signature: 8a477f597d28d172789f06886806bc55\n");
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 0 });
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    expect(lines.filter((line) => line.includes("not made by the server"))).toHaveLength(1);
    // The folder a link would name is tagged and full: still never reached through the link.
    const elsewhere = join(f.root, "elsewhere-home");
    const target = tagged(elsewhere);
    put(join(target, "pip", "a"), 100, 9, target);
    rmSync(f.tools, { recursive: true });
    symlinkSync(target, f.tools);
    expect(await sweeper(f).made.clearCaches({ dryRun: false })).toMatchObject({ entries: 0 });
    expect(existsSync(join(target, "pip", "a"))).toBe(true);
  });

  it("with the box off (or the tools' switch off), the tools' folders are not touched", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    expect(await sweeper(f, { tools: () => false }).made.clearCaches({ dryRun: false, scope: "all" })).toMatchObject({ entries: 0 });
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
  });

  it("never deletes while a bot works: a turn or a warm engine, or a process using the root; tried again on the next tick", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    put(join(f.tools, "uv", "a"), 100, 2, f.tools);
    let working = true, using = false, full = true;
    const inUse = async (roots: readonly string[]) => new Set(using ? roots : []);
    const { made, lines } = sweeper(f, { ...withCap("150K"), busy: () => working, inUse, volume: async () => ({ total: 100 * GIB, free: full ? 1 * GIB : 50 * GIB }) });
    expect(await made.sweep()).toEqual({ skipped: "busy" });
    expect(await made.emergency()).toMatchObject({ entries: 0, busy: 1 });
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 0, busy: 1 });
    working = false; using = true;
    expect(await made.sweep()).toMatchObject({ busy: true });
    expect(await made.emergency()).toMatchObject({ entries: 0, busy: 1 });
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 0, busy: 1 });
    expect(existsSync(join(f.tools, "pip", "a"))).toBe(true);
    expect(lines.filter((line) => line.includes("a bot is working, so no cache was removed"))).toHaveLength(1);
    expect((await made.report()).lastSweep).toBeNull();
    // The next tick (minutes later, not an hour) finds the home idle and does the pass it put off.
    using = false; full = false;
    await made.tick();
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    expect(existsSync(join(f.tools, "uv", "a"))).toBe(true);
    expect((await made.report()).lastSweep).toMatchObject({ at: NOW });
  });

  it("a real process working in the root (its working folder there) holds every deletion until it ends", async () => {
    const f = fixture();
    put(join(f.tools, "uv", "archive-v0", "env", "lib.py"), 10, 9, f.tools);
    const child = spawn("sleep", ["60"], { cwd: join(f.tools, "uv", "archive-v0", "env"), stdio: "ignore" });
    children.push(child);
    const exited = new Promise((done) => child.once("exit", done));
    await new Promise((done) => child.once("spawn", done));
    const lines: string[] = [];
    const made = createCacheSweeper({ dataDir: f.dataDir, home: f.home, env: ON, tools: () => true, audienceHomes: () => [], keep: () => [], volume: ROOMY, now: () => NOW, log: (line) => lines.push(line) });
    made.start(() => false);
    made.stop();
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 0, busy: 1 });
    expect(existsSync(join(f.tools, "uv", "archive-v0", "env", "lib.py"))).toBe(true);
    child.kill("SIGKILL");
    await exited;
    // A process of this user that cannot be read, or another one in the root, would hold it: the message names it.
    const holders: string[] = [];
    await rootsInUse([f.tools], { unreadable: (pid) => holders.push(`unreadable ${pid} ${cmdline(pid)}`), using: (pid) => holders.push(`using ${pid} ${cmdline(pid)}`) });
    expect(await made.clearCaches({ dryRun: false }), [...holders, ...lines].join("\n")).toMatchObject({ entries: 1, busy: 0 });
    expect(existsSync(join(f.tools, "uv"))).toBe(false);
  });

  it("the emergency pass removes the least recently written until the disk is under 90%, then waits", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    put(join(f.tools, "uv", "a"), 100, 3, f.tools);
    const volume = async () => ({ total: 100, free: existsSync(join(f.tools, "pip")) ? 4 : 15 });
    const { made, lines } = sweeper(f, { volume });
    expect(await made.emergency()).toMatchObject({ entries: 1 });
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    expect(existsSync(join(f.tools, "uv", "a"))).toBe(true);
    expect(lines.some((line) => line.includes("96% full: removed 1"))).toBe(true);
    expect((await made.report()).emergency).toMatchObject({ count: 1, at: NOW });
    expect(await sweeper(f, { volume: async () => ({ total: 100, free: 50 }) }).made.emergency()).toEqual({ skipped: "room" });
  });

  it("a Team Cloud: each audience's root has its share of the cap, and a process in one member's root does not hold another's", async () => {
    const f = fixture();
    const ana = join(f.dataDir, "engine-homes", "member-a"), ben = join(f.dataDir, "engine-homes", "member-b");
    const anaRoot = tagged(ana), benRoot = tagged(ben);
    for (const root of [anaRoot, benRoot]) { put(join(root, "pip", "a"), 150, 9, root); put(join(root, "uv", "a"), 150, 2, root); }
    // Three roots (the server's HOME, ana, ben): 600K split three ways is 200K each, and ana and ben each hold about 310K.
    const { made } = sweeper(f, { ...withCap("600K"), audienceHomes: () => [ana, ben], inUse: async (roots) => new Set(roots.filter((root) => root === benRoot)) });
    expect(await made.sweep()).toMatchObject({ busy: true });
    expect(existsSync(join(anaRoot, "pip"))).toBe(false);
    expect(existsSync(join(anaRoot, "uv", "a"))).toBe(true);
    expect(existsSync(join(benRoot, "pip", "a"))).toBe(true);
  });

  it("the app's own folder: old Node compile caches go, the running server's and anything else stay", async () => {
    const f = fixture();
    put(join(f.app, "node-compile", "v24.1.0-x64-aaaa", "f"), 10, 9, f.app);
    put(join(f.app, "node-compile", "v24.2.0-x64-bbbb", "f"), 10, 9, f.app);
    put(join(f.app, "storage-report.json"), 1, 9, f.app);
    const { made } = sweeper(f, { keep: () => [join(f.app, "node-compile", "v24.2.0-x64-bbbb")] });
    expect(await made.clearCaches({ dryRun: true, scope: "app" })).toMatchObject({ entries: 1 });
    expect(existsSync(join(f.app, "node-compile", "v24.1.0-x64-aaaa"))).toBe(true);
    expect(await made.clearCaches({ dryRun: false, scope: "app" })).toMatchObject({ entries: 1 });
    expect(readdirSync(join(f.app, "node-compile"))).toEqual(["v24.2.0-x64-bbbb"]);
    expect(existsSync(join(f.app, "storage-report.json"))).toBe(true);
  });

  it("a read-only tree is removed, made writable through its own folders", async () => {
    const f = fixture();
    put(join(f.tools, "uv", "archive-v0", "a"), 10, 9, f.tools);
    chmodSync(join(f.tools, "uv", "archive-v0", "a"), 0o444);
    chmodSync(join(f.tools, "uv", "archive-v0"), 0o555);
    chmodSync(join(f.tools, "uv"), 0o555);
    expect(await sweeper(f).made.clearCaches({ dryRun: false })).toMatchObject({ entries: 1, partial: 0 });
    expect(readdirSync(f.tools)).toEqual([CACHE_TAG_FILE]);
  });

  it("a folder goes out of sight first: renamed in its own root, never put back; what a stopped removal left is finished next time", async () => {
    const f = fixture();
    put(join(f.tools, ".omb-trash-0a0b0c", "uv", "x"), 10, 9, f.tools);
    put(join(f.tools, "huggingface", ".omb-trash-0d0e0f", "models--o--m", "x"), 10, 9, f.tools);
    const outside = join(f.root, "outside");
    put(join(outside, "keep"), 1, 9, f.root);
    symlinkSync(outside, join(f.tools, ".omb-trash-1a1b1c"));
    put(join(f.tools, "pip", "a"), 10, 9, f.tools);
    expect(await sweeper(f).made.clearCaches({ dryRun: false })).toMatchObject({ entries: 1, partial: 0 });
    expect(readdirSync(f.tools).sort()).toEqual([CACHE_TAG_FILE, "huggingface"]);
    expect(readdirSync(join(f.tools, "huggingface"))).toEqual([]);
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });

  it("folders nested far deeper than any tool's are not followed to the end: the walk stops at 128 and says so", async () => {
    const f = fixture();
    const chain = (levels: number) => join(f.tools, "uv", ...Array.from({ length: levels }, () => "d"));
    mkdirSync(chain(200), { recursive: true });
    writeFileSync(join(chain(200), "bottom"), "x");
    const { made } = sweeper(f);
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 1, partial: 1 });
    // What lies past the limit stays, under the renamed folder, and only that.
    const left = readdirSync(f.tools).filter((name) => name.startsWith(".omb-trash-"));
    expect(left).toHaveLength(1);
    expect(existsSync(join(f.tools, "uv"))).toBe(false);
    // A shallower tree goes whole.
    mkdirSync(chain(100), { recursive: true });
    writeFileSync(join(chain(100), "bottom"), "x");
    expect(await made.clearCaches({ dryRun: false })).toMatchObject({ entries: 1, partial: 0 });
  });

  it("a time in the state file later than now (a clock set back) does not hold off a pass", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    put(join(f.tools, "uv", "a"), 100, 2, f.tools);
    writeFileSync(join(f.dataDir, "cache-sweep.json"), JSON.stringify({ lastSweep: { at: NOW + DAY, roots: {} }, emergency: { count: 1, bytes: 1, at: NOW + DAY } }));
    const { made } = sweeper(f, { ...withCap("150K"), volume: async () => ({ total: 100 * GIB, free: 50 * GIB }) });
    await made.tick();
    expect(existsSync(join(f.tools, "pip"))).toBe(false);
    const full = sweeper(f, { volume: async () => ({ total: 100, free: 1 }) }).made;
    expect(await full.emergency()).not.toEqual({ skipped: "backoff" });
  });

  it("a state file of any shape: every pass still runs, and it is replaced whole", async () => {
    const f = fixture();
    put(join(f.tools, "pip", "a"), 100, 9, f.tools);
    writeFileSync(join(f.dataDir, "cache-sweep.json"), '{"measured":null,"cleared":null}');
    const { made } = sweeper(f, withCap("1K"));
    expect(await made.sweep()).toMatchObject({ busy: false });
    expect(readdirSync(f.dataDir).filter((name) => name.startsWith("cache-sweep"))).toEqual(["cache-sweep.json"]);
  });
});

describe.skipIf(process.platform !== "linux")("never outside the root", () => {
  /** The bot's unit, and a folder outside every root that a bot names: another member's engine home. */
  function scene() {
    const f = fixture();
    const victim = join(f.dataDir, "engine-homes", "member-0000000000000000");
    put(join(victim, "abcd", "transcript.jsonl"), 1, 30, f.dataDir);
    put(join(f.tools, "npm", "_npx", "abcd", "x"), 1, 30, f.tools);
    return { ...f, victim };
  }
  const unit: Unit = { group: "tools", root: "", name: "npm" };
  const opened = async (f: ReturnType<typeof fixture>) => {
    const result = await openRoot({ group: "tools", path: f.tools }, [f.home, f.dataDir]);
    if (!result || !("folder" in result)) throw new Error("root not opened");
    return result.folder;
  };

  it("a unit swapped for a link between the check and the removal: nothing is removed, and the folder it names stays", async () => {
    const f = scene();
    const folder = await opened(f);
    try {
      expect(await measureUnit(folder, unit, new Pacer())).toMatchObject({ files: 4 });
      renameSync(join(f.tools, "npm"), join(f.tools, "npm-real"));
      symlinkSync(f.victim, join(f.tools, "npm"));
      expect(await removeUnit(folder, unit, new Pacer())).toBeNull();
    } finally { await close(folder); }
    expect(existsSync(join(f.victim, "abcd", "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(f.tools, "npm-real", "_npx", "abcd", "x"))).toBe(true);
  });

  it("a folder inside the unit that is a link is removed as a link, never followed", async () => {
    const f = scene();
    rmSync(join(f.tools, "npm", "_npx"), { recursive: true });
    symlinkSync(f.victim, join(f.tools, "npm", "_npx"));
    const folder = await opened(f);
    try { expect(await removeUnit(folder, unit, new Pacer())).toMatchObject({ partial: false }); } finally { await close(folder); }
    expect(existsSync(join(f.tools, "npm"))).toBe(false);
    expect(existsSync(join(f.victim, "abcd", "transcript.jsonl"))).toBe(true);
  });

  it("the whole root swapped for a link after it was opened: the removal stays in the folder it opened", async () => {
    const f = scene();
    const folder = await opened(f);
    try {
      renameSync(f.tools, `${f.tools}-moved`);
      symlinkSync(f.victim, f.tools);
      mkdirSync(join(f.victim, "npm"));
      writeFileSync(join(f.victim, "npm", "keep"), "theirs");
      expect(await removeUnit(folder, unit, new Pacer())).toMatchObject({ partial: false });
    } finally { await close(folder); }
    expect(existsSync(join(`${f.tools}-moved`, "npm"))).toBe(false);
    expect(existsSync(join(f.victim, "npm", "keep"))).toBe(true);
    expect(existsSync(join(f.victim, "abcd", "transcript.jsonl"))).toBe(true);
  });

  it("a bot flipping folders for links to a folder outside while the unit is deleted never reaches it (20 runs)", async () => {
    const f = fixture();
    const precious = join(f.root, "precious");
    for (let j = 0; j < 100; j++) put(join(precious, `p${j}`), 1, 30, f.root);
    const racer = join(f.root, "racer.mjs");
    // The racer swaps each d<i> for a link to `precious` and back, as fast as it can, in the unit or the name it was
    // renamed to on its way out, until neither is there.
    writeFileSync(racer, `
      import { readdirSync, renameSync, symlinkSync, unlinkSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const [root, name, precious] = process.argv.slice(2);
      const target = () => {
        if (existsSync(join(root, name))) return join(root, name);
        const trash = readdirSync(root).find((entry) => entry.startsWith(".omb-trash-"));
        return trash ? join(root, trash) : null;
      };
      process.send?.("ready");
      for (let unit = target(); unit; unit = target()) {
        for (let i = 0; i < 200; i++) {
          const d = join(unit, "d" + i);
          try { renameSync(d, d + ".r"); } catch { continue; }
          try { symlinkSync(precious, d); } catch {}
          try { unlinkSync(d); } catch {}
          try { renameSync(d + ".r", d); } catch {}
        }
      }
    `);
    for (let run = 0; run < 20; run++) {
      const unitPath = join(f.tools, "uv");
      for (let i = 0; i < 200; i++) for (let j = 0; j < 5; j++) put(join(unitPath, `d${i}`, `f${j}`), 1, 30, f.tools);
      const child = spawn(process.execPath, [racer, f.tools, "uv", precious], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.push(child);
      // It ends by itself once the unit is gone, maybe before the kill below.
      const exited = new Promise((done) => child.once("exit", done));
      await new Promise((done) => child.once("message", done));
      const folder = await opened(f);
      try { await removeUnit(folder, { group: "tools", root: f.tools, name: "uv" }, new Pacer()); } finally { await close(folder); }
      child.kill("SIGKILL");
      await exited;
      expect(readdirSync(precious), `run ${run}`).toHaveLength(100);
      for (const name of readdirSync(f.tools)) if (name === "uv" || name.startsWith(".omb-trash-")) rmSync(join(f.tools, name), { recursive: true, force: true });
    }
  }, 120_000);
});
