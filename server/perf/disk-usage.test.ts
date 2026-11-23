import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { requiredScope, serviceAllowed } from "../request-auth.ts";
import { createPerfDiagnosticsRoutes, STORAGE_PATH } from "../routes/perf-diagnostics.ts";
import type { RouteContext } from "../routes/table.ts";
import { STORAGE_CATEGORIES } from "./disk-categories.ts";
import { MAX_BOTS, nodeWalkFs, type WalkFs } from "./disk-walk.ts";
import { cloudStorage, createPerfHost } from "./perf-host.ts";
import { createDiskUsage, readSavedPass, readSavedProgress, STORAGE_HEALTH_MAX_BYTES, storageHealth, type DiskUsageOptions, type StorageReport } from "./disk-usage.ts";

const START = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A Cloud home's volume: HOME with the data folder inside, and names that must never leave it. */
function volume() {
  const home = mkdtempSync(join(tmpdir(), "disk-usage-"));
  dirs.push(home);
  const data = join(home, ".openmausbot");
  const write = (path: string, bytes = 1_000) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 7)); };
  write(join(data, "messages.db"), 20_000);
  write(join(data, "workspaces", "bot-known", "Acme merger plan.md"), 8_000);
  write(join(data, "task-workspaces", "bot-known", "thread-1", "ada@example.test.csv"), 4_000);
  write(join(data, "workspaces", "bot-gone", "old.txt"), 2_000);
  write(join(data, "Tallyspoon-secrets", "token.txt"));
  write(join(home, "acme-merger", "sk-ant-api03-PRIVATE.txt"));
  write(join(home, "lost+found", "x"));
  write(join(home, ".cache", "ms-playwright", "chromium-1", "chrome"), 6_000);
  return { home, data };
}

function usage(overrides: Partial<DiskUsageOptions> = {}) {
  const { home, data } = volume();
  let clock = START, mono = 0, busy = false;
  const disk = createDiskUsage({
    roots: [{ path: home, scope: "home" }, { path: data, scope: "data" }], volume: home, timer: false,
    now: () => clock, monotonic: () => mono, busy: () => busy, knownBot: (id) => id === "bot-known",
    statfs: async () => ({ blocks: 1_000_000, bsize: 4096, bavail: 400_000, bfree: 450_000 }),
    firstPassAfterMs: 60_000, passEveryMs: 3_600_000, tickMs: 2_000, ...overrides,
  });
  return { disk, home, data, advance: (ms: number) => { clock += ms; }, tickMono: (ms: number) => { mono += ms; }, setBusy: (value: boolean) => { busy = value; } };
}

async function untilDone(w: ReturnType<typeof usage>, max = 1_000) {
  for (let index = 0; index < max && (w.disk.running() || w.disk.report().at === null); index++) { w.advance(2_000); await w.disk.tick(); }
}

describe("storage sampler", () => {
  it("waits for its first pass after boot, then reports each category with its class, the volume and the bots the store knows", async () => {
    const w = usage();
    await w.disk.tick();
    expect(w.disk.running()).toBe(false);
    expect(w.disk.report()).toMatchObject({ v: 1, at: null, running: false, categories: [], bots: [], volume: null, other: null });
    w.advance(60_000);
    await untilDone(w);
    const report = w.disk.report();
    expect(report).toMatchObject({ v: 1, running: false, progress: null, failed: false, volume: { totalBytes: 4_096_000_000, freeBytes: 1_638_400_000, usedBytes: 2_252_800_000 } });
    const names = report.categories.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["conversations", "bot_files", "browser_engines", "other"]));
    for (const row of report.categories) expect(row.class).toBe(STORAGE_CATEGORIES[row.name]);
    const sizes = report.categories.map((row) => row.bytes);
    expect(sizes).toEqual(sizes.toSorted((a, b) => b - a));
    expect(report.bots.map((bot) => bot.id)).toEqual(["bot-known"]);
    expect(report.bots[0]!.files).toBe(2);
    expect(report.botsRest).toMatchObject({ count: 1, files: 1 });
    expect(report.walkedBytes! + report.unwalkedBytes!).toBeGreaterThanOrEqual(report.walkedBytes!);
    expect(report.other).toMatchObject({ named: [{ name: "lost+found", files: 1 }], unlisted: { files: 2, entries: 2 } });
    w.advance(30_000);
    expect(w.disk.report().ageS).toBe(30);
  });

  it("never names a file or folder outside its allow-list, nor a bot the store does not know", async () => {
    const w = usage();
    w.advance(60_000);
    await untilDone(w);
    const text = JSON.stringify(storageHealth(w.disk.report()));
    for (const secret of ["Acme", "acme-merger", "ada@example.test", "Tallyspoon", "sk-ant", "PRIVATE", "token.txt", "bot-gone", "plan.md", "ms-playwright", w.home]) expect(text).not.toContain(secret);
  });

  it("starts no step while a turn runs, stops a step under way when one starts, and reports how long it waited", async () => {
    let calls = 0, busyAfter = Infinity;
    const counting: WalkFs = { opendir: nodeWalkFs.opendir, lstat: async (path) => { calls += 1; return nodeWalkFs.lstat(path); } };
    const w = usage({ fs: counting, busy: () => calls >= busyAfter });
    w.advance(60_000);
    busyAfter = 3;
    await w.disk.tick();
    expect(w.disk.running()).toBe(true);
    const read = calls;
    expect(read).toBe(3);
    for (let index = 0; index < 5; index++) { w.advance(2_000); await w.disk.tick(); }
    expect(calls).toBe(read);
    expect(w.disk.report()).toMatchObject({ running: true, at: null, progress: { waitedS: 10 } });
    busyAfter = Infinity;
    await untilDone(w);
    expect(w.disk.report()).toMatchObject({ running: false, progress: null });
    expect(w.disk.report().at).not.toBeNull();
  });

  it("keeps each tick within its entry and time budget, and passes again only when due", async () => {
    let mono = 0;
    const slow: WalkFs = { opendir: nodeWalkFs.opendir, lstat: async (path) => { mono += 10; return nodeWalkFs.lstat(path); } };
    const w = usage({ fs: slow, monotonic: () => mono, tickBudgetMs: 25, tickEntries: 1_000 });
    w.advance(60_000);
    await w.disk.tick();
    expect(w.disk.report().progress!.entries).toBeLessThanOrEqual(3);
    await untilDone(w);
    const first = w.disk.report().at!;
    w.advance(1_800_000);
    await w.disk.tick();
    expect(w.disk.running()).toBe(false);
    w.advance(1_800_000);
    await w.disk.tick();
    expect(w.disk.running() || w.disk.report().at! > first).toBe(true);
  });

  it("counts what it cannot read and still finishes the pass", async () => {
    let broken = false;
    const flaky: WalkFs = { opendir: async (path) => { if (broken) throw Object.assign(new Error("EIO"), { code: "EIO" }); return nodeWalkFs.opendir(path); }, lstat: nodeWalkFs.lstat };
    const w = usage({ fs: flaky });
    w.advance(60_000);
    await untilDone(w);
    const before = w.disk.report();
    broken = true;
    w.disk.passNow();
    for (let index = 0; index < 50 && (index === 0 || w.disk.running()); index++) { w.advance(2_000); await w.disk.tick(); }
    const after = w.disk.report();
    expect(after).toMatchObject({ failed: false, running: false });
    expect(after.skipped!.unreadable).toBeGreaterThan(0);
    expect(after.at).toBeGreaterThan(before.at!);
  });

  it("keeps the last figures and says so when a pass fails", async () => {
    let broken = false;
    const failing: WalkFs = {
      opendir: nodeWalkFs.opendir,
      lstat: async (path) => {
        const stat = await nodeWalkFs.lstat(path);
        return broken ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isDirectory: () => { throw new TypeError("bad stat"); } }) : stat;
      },
    };
    const w = usage({ fs: failing });
    w.advance(60_000);
    await untilDone(w);
    const before = w.disk.report();
    broken = true;
    w.disk.passNow();
    w.advance(2_000);
    await w.disk.tick();
    const after = w.disk.report();
    expect(after).toMatchObject({ failed: true, running: false, at: before.at, categories: before.categories });
  });

  it("stops at once and closes what it holds", async () => {
    const w = usage({ tickEntries: 2 });
    w.advance(60_000);
    await w.disk.tick();
    expect(w.disk.running()).toBe(true);
    await w.disk.stop();
    expect(w.disk.running()).toBe(false);
    w.advance(2_000);
    await w.disk.tick();
    expect(w.disk.running()).toBe(false);
  });

  it("keeps the last pass across a restart and waits until it is due again", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "disk-usage-saved-")), "cache", "storage-report.json");
    dirs.push(join(file, "..", ".."));
    const w = usage({ file });
    w.advance(60_000);
    await untilDone(w);
    const before = w.disk.report();
    let clock = before.at! + 60_000;
    const again = createDiskUsage({ roots: [{ path: w.home, scope: "home" }], volume: w.home, timer: false, file, now: () => clock, knownBot: (id) => id === "bot-known",
      firstPassAfterMs: 60_000, passEveryMs: 3_600_000 });
    expect({ ...again.report(), ageS: before.ageS }).toEqual({ ...before, ageS: before.ageS });
    clock += 120_000;
    await again.tick();
    expect(again.report().at).toBe(before.at);
    clock = before.at! + 3_600_000;
    await again.tick();
    expect(again.running() || again.report().at! > before.at!).toBe(true);
    await again.stop();
  });

  it("reads back a saved pass field by field: a name that is not a category, a known-shaped id or an allowed name is dropped", () => {
    const saved = readSavedPass(JSON.stringify({ v: 1, at: START, tookMs: 5, volume: { totalBytes: 10, freeBytes: "x", usedBytes: -1 }, totals: {
      categories: { conversations: { bytes: 5, files: 1 }, "acme-merger": { bytes: 9, files: 9 } }, bots: [["bot-known", { bytes: 3, files: 1 }], ["Ada's plans", { bytes: 1, files: 1 }]],
      otherNamed: [["lost+found", { bytes: 1, files: 0 }], ["acme-merger", { bytes: 1, files: 1 }]], walkedBytes: 7, entries: 2 } }))!;
    expect(saved.volume).toEqual({ totalBytes: 10, freeBytes: 0, usedBytes: 0 });
    expect(saved.totals.categories.conversations).toEqual({ bytes: 5, files: 1 });
    expect(Object.keys(saved.totals.categories)).not.toContain("acme-merger");
    expect([...saved.totals.bots.keys()]).toEqual(["bot-known"]);
    expect([...saved.totals.otherNamed.keys()]).toEqual(["lost+found"]);
    expect(readSavedPass("{")).toBeNull();
    expect(readSavedPass(JSON.stringify({ v: 2, at: START }))).toBeNull();
  });

  it("never records a pass cut short by stop as complete", async () => {
    let w: ReturnType<typeof usage> | null = null;
    const stopping: WalkFs = { opendir: nodeWalkFs.opendir, lstat: async (path) => { if (path.endsWith("messages.db")) void w!.disk.stop(); return nodeWalkFs.lstat(path); } };
    w = usage({ fs: stopping });
    w.advance(60_000);
    for (let index = 0; index < 50; index++) { w.advance(2_000); await w.disk.tick(); }
    expect(w.disk.report()).toMatchObject({ at: null, running: false, failed: false });
  });

  it("goes on after a restart from where the pass was saved, to the same figures as one pass", async () => {
    const folder = mkdtempSync(join(tmpdir(), "disk-usage-progress-"));
    dirs.push(folder);
    const progressFile = join(folder, "cache", "storage-progress.json"), file = join(folder, "cache", "storage-report.json");
    const whole = usage({ tickEntries: 1_000_000 });
    whole.advance(60_000);
    await untilDone(whole);
    const expected = whole.disk.report();

    const { home, data } = volume();
    let clock = START;
    const make = () => createDiskUsage({ roots: [{ path: home, scope: "home" }, { path: data, scope: "data" }], volume: home, timer: false, file, progressFile,
      now: () => clock, knownBot: (id) => id === "bot-known", statfs: async () => ({ blocks: 1_000_000, bsize: 4096, bavail: 400_000, bfree: 450_000 }),
      firstPassAfterMs: 60_000, passEveryMs: 3_600_000, tickEntries: 2 });
    let disk = make();
    clock += 60_000;
    let restarts = 0;
    for (let index = 0; index < 500 && disk.report().at === null; index++) {
      clock += 61_000;
      await disk.tick();
      if (existsSync(progressFile) && index % 5 === 4) { await disk.stop(); disk = make(); restarts += 1; clock += 60_000; }
    }
    expect(restarts).toBeGreaterThan(0);
    const report = disk.report();
    expect(report.resumes).toBeGreaterThan(0);
    const figures = (one: StorageReport) => ({ categories: one.categories, bots: one.bots, botsRest: one.botsRest, other: one.other, walkedBytes: one.walkedBytes });
    expect(figures(report)).toEqual(figures(expected));
    expect(existsSync(progressFile)).toBe(false);
  });

  it("starts again from nothing on a saved pass that is unreadable, too old or names a folder outside the roots", () => {
    const { home } = volume();
    const roots = [{ path: home, scope: "home" as const }];
    const saved = (checkpoint: unknown, savedAt = START) => JSON.stringify({ v: 1, startedAt: START, waitedMs: 0, savedAt, checkpoint });
    const totals = { categories: {}, bots: [] };
    expect(readSavedProgress(saved({ totals, doneRoots: [], frames: [{ path: home, names: ["a"] }] }), roots, START)).not.toBeNull();
    expect(readSavedProgress(saved({ totals, doneRoots: [], frames: [{ path: home, names: ["a"] }] }), roots, START + 8 * 24 * 3_600_000)).toBeNull();
    expect(readSavedProgress(saved({ totals, doneRoots: [], frames: [{ path: "/etc", names: ["passwd"] }] }), roots, START)).toBeNull();
    expect(readSavedProgress("{", roots, START)).toBeNull();
  });

  it("walks only on a Cloud home: the desktop app and a self-hosted server measure nothing", () => {
    expect(cloudStorage(null, "/home/ada", () => true)).toEqual({});
    expect(cloudStorage(undefined, "/home/ada", () => true)).toEqual({});
    expect(cloudStorage({ adminOrigin: "https://admin.test" }, "/data", () => true).storage?.home).toBe("/data");
    const store = { onChange: () => () => {}, botByThread: () => null };
    const bus = { subscribe: () => () => {} };
    const { home } = volume();
    expect(createPerfHost({ dataDir: home, timer: false, wholeMachine: false, bus, store, ...cloudStorage(null, home, () => true) }).storage()).toBeNull();
    expect(createPerfHost({ dataDir: home, timer: false, wholeMachine: true, bus, store, ...cloudStorage({}, home, () => true) }).storage()).toMatchObject({ v: 1, at: null });
    const index = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
    expect(index.match(/\.\.\.cloudStorage\(CLOUD_HOME, homedir\(\), /g)).toHaveLength(1);
    expect(index).not.toMatch(/storage: \{ home:/);
  });

  it("walks a data folder that is HOME itself once", async () => {
    const { home } = volume();
    const disk = createDiskUsage({ roots: [{ path: home, scope: "home" }, { path: home, scope: "data" }], volume: home, timer: false, firstPassAfterMs: 0, now: () => START });
    for (let index = 0; index < 100 && (disk.running() || disk.report().at === null); index++) await disk.tick();
    const files = disk.report().categories.reduce((sum, row) => sum + row.files, 0);
    expect(files).toBe(8);
  });
});

/** The largest report the sampler can make: every category, as many bots as it keeps, every allowed name, 16-digit numbers. */
function worstCase(): StorageReport {
  const big = 4_000_000_000_000_000;
  const tally = { bytes: big, files: big };
  return {
    v: 1, at: big, ageS: big, tookS: big, running: true, progress: { entries: big, waitedS: big },
    volume: { totalBytes: big, freeBytes: big, usedBytes: big }, walkedBytes: big, unwalkedBytes: big,
    categories: Object.entries(STORAGE_CATEGORIES).map(([name, value]) => ({ name: name as keyof typeof STORAGE_CATEGORIES, class: value, ...tally })),
    bots: Array.from({ length: Math.min(MAX_BOTS, 10) }, (_, index) => ({ id: `${"b".repeat(62)}${String(index).padStart(2, "0")}`, ...tally })),
    botsRest: { ...tally, count: big },
    other: { named: Array.from({ length: 5 }, (_, index) => ({ name: `lost+found${index}`, ...tally })), unlisted: { ...tally, entries: big } },
    skipped: { unreadable: big, otherDevice: big, tooDeep: big, vanished: big, links: big }, linksCapped: true, linksUncheckedBytes: big, resumes: big, failed: true,
  };
}

describe("storage in the health read", () => {
  it("fits its own budget untrimmed at the largest the sampler makes", () => {
    const report = worstCase();
    expect(JSON.stringify(report).length).toBeLessThanOrEqual(STORAGE_HEALTH_MAX_BYTES);
    expect(storageHealth(report)).toEqual(report);
  });

  it("drops bots into the rest before anything else when a report is over its budget", () => {
    const report = worstCase();
    report.bots = Array.from({ length: 40 }, (_, index) => ({ ...report.bots[0]!, id: `${"c".repeat(62)}${String(index).padStart(2, "0")}` }));
    const trimmed = storageHealth(report);
    expect(JSON.stringify(report).length).toBeGreaterThan(STORAGE_HEALTH_MAX_BYTES);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(STORAGE_HEALTH_MAX_BYTES);
    expect(trimmed.categories).toHaveLength(Object.keys(STORAGE_CATEGORIES).length);
    expect(trimmed.v).toBe(1);
    expect(trimmed.bots.length).toBeLessThan(report.bots.length);
    expect(trimmed.botsRest.count).toBe(report.botsRest.count + report.bots.length - trimmed.bots.length);
    expect(trimmed.botsRest.bytes).toBeGreaterThan(report.botsRest.bytes);
  });

  it("leaves a small report as it is", async () => {
    const w = usage();
    w.advance(60_000);
    await untilDone(w);
    const report = w.disk.report();
    expect(storageHealth(report)).toEqual(report);
  });
});

describe("GET /api/diagnostics/storage", () => {
  async function get(storage?: () => StorageReport | null) {
    let answered: { status: number; body: unknown } | null = null;
    const route = createPerfDiagnosticsRoutes({ text: () => "", ...(storage ? { storage } : {}) });
    const result = await route({
      req: {} as RouteContext["req"], res: { setHeader: () => undefined } as unknown as RouteContext["res"], url: new URL(`http://x${STORAGE_PATH}`), path: STORAGE_PATH, method: "GET",
      auth: {} as RouteContext["auth"], json: ((_res: unknown, status: number, body: unknown) => { answered = { status, body }; }) as unknown as RouteContext["json"], readBody: (async () => null) as unknown as RouteContext["readBody"],
    });
    return { result, answered: answered as { status: number; body: unknown } | null };
  }

  it("answers the owner with the report, or null where the home measures nothing", async () => {
    const report = worstCase();
    expect((await get(() => report)).answered).toEqual({ status: 200, body: { storage: report } });
    expect((await get()).answered).toEqual({ status: 200, body: { storage: null } });
  });

  it("is admin scope: a Team Cloud member's session and a service caller never reach it", () => {
    expect(requiredScope("GET", STORAGE_PATH)).toBe("admin");
    expect(serviceAllowed("GET", STORAGE_PATH)).toBe(false);
  });
});
