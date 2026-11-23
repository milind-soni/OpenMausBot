import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { allocatedBytes, checkpointFrom, createDiskWalk, nodeWalkFs, totalsJson, type WalkCheckpoint, type WalkFs, type WalkRoot, type WalkStat, type WalkTotals } from "./disk-walk.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { chmodSync(join(dir, "data", "workspaces", "locked"), 0o700); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

function tree(): { home: string; data: string; roots: WalkRoot[] } {
  const home = mkdtempSync(join(tmpdir(), "disk-walk-"));
  dirs.push(home);
  const data = join(home, "data");
  const write = (path: string, bytes: number) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 1)); };
  write(join(data, "messages.db"), 10_000);
  write(join(data, "workspaces", "bot1", "notes.md"), 5_000);
  write(join(data, "task-workspaces", "bot1", "t1", "out.csv"), 7_000);
  write(join(data, "task-workspaces", "bot2", "t1", "app", "node_modules", "x", "index.js"), 3_000);
  write(join(data, "browser", "profiles", "p1", "Default", "Cookies"), 2_000);
  write(join(data, "browser", "profiles", "p1", "Default", "Cache", "Cache_Data", "f"), 9_000);
  write(join(home, ".npm", "_cacache", "x"), 4_000);
  write(join(home, "acme-merger", "plan.md"), 1_000);
  return { home, data, roots: [{ path: home, scope: "home" }, { path: data, scope: "data" }] };
}

async function walkAll(roots: WalkRoot[], options: Parameters<typeof createDiskWalk>[1] = {}, entries = 1_000_000) {
  const walk = createDiskWalk(roots, options);
  let steps = 0;
  while (!(await walk.step({ entries, stop: () => false }))) steps += 1;
  return { totals: walk.totals, steps };
}

const fileCounts = (totals: Awaited<ReturnType<typeof walkAll>>["totals"]) =>
  Object.fromEntries(Object.entries(totals.categories).filter(([, tally]) => tally.files).map(([name, tally]) => [name, tally.files]));

describe("disk walk", () => {
  it("counts each file once into its category and bot, walking the data folder as its own root", async () => {
    const { roots } = tree();
    const { totals } = await walkAll(roots);
    expect(fileCounts(totals)).toEqual({ conversations: 1, bot_files: 2, packages: 2, browser_profiles: 1, browser_cache: 1, other: 1 });
    expect(totals.bots.get("bot1")?.files).toBe(2);
    expect(totals.bots.get("bot2")?.files).toBe(1);
    expect(totals.otherUnlisted).toMatchObject({ files: 1, entries: 1 });
    expect(totals.categories.conversations.bytes).toBeGreaterThanOrEqual(10_000);
    expect(totals.walkedBytes).toBe(Object.values(totals.categories).reduce((sum, tally) => sum + tally.bytes, 0));
  });

  it("goes on where it stopped: one entry a step gives the same totals as one step", async () => {
    const { roots } = tree();
    const whole = await walkAll(roots);
    const stepped = await walkAll(roots, {}, 1);
    expect(stepped.steps).toBeGreaterThan(10);
    expect(stepped.totals).toEqual(whole.totals);
  });

  it("stops before the next entry when told to, and reads nothing more", async () => {
    const { roots } = tree();
    const walk = createDiskWalk(roots);
    let calls = 0;
    expect(await walk.step({ entries: 1_000, stop: () => ++calls > 3 })).toBe(false);
    expect(walk.totals.entries).toBeLessThanOrEqual(3);
    const before = walk.totals.entries;
    expect(await walk.step({ entries: 1_000, stop: () => true })).toBe(false);
    expect(walk.totals.entries).toBe(before);
    await walk.close();
    expect(walk.done).toBe(true);
  });

  it.skipIf(process.platform === "win32")("never follows a symbolic link, to a folder or a file", async () => {
    const { home, data, roots } = tree();
    const outside = mkdtempSync(join(tmpdir(), "disk-walk-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "big"), Buffer.alloc(200_000, 1));
    const before = (await walkAll(roots)).totals.walkedBytes;
    symlinkSync(outside, join(data, "workspaces", "bot1", "linked-folder"));
    symlinkSync(join(outside, "big"), join(home, "linked-file"));
    const { totals } = await walkAll(roots);
    expect(totals.skipped.links).toBe(2);
    expect(totals.walkedBytes - before).toBeLessThan(200_000);
    expect(totals.categories.bot_files.files).toBe(3);
  });

  it.skipIf(process.platform === "win32")("counts a hard-linked file once", async () => {
    const { data, roots } = tree();
    linkSync(join(data, "messages.db"), join(data, "workspaces", "bot1", "copy.db"));
    const { totals } = await walkAll(roots);
    expect(totals.categories.conversations.files + totals.categories.bot_files.files).toBe(3);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("skips a folder it cannot read and goes on", async () => {
    const { data, roots } = tree();
    mkdirSync(join(data, "workspaces", "locked"));
    writeFileSync(join(data, "workspaces", "locked", "secret"), "x");
    chmodSync(join(data, "workspaces", "locked"), 0o000);
    const { totals } = await walkAll(roots);
    expect(totals.skipped.unreadable).toBe(1);
    expect(totals.categories.conversations.files).toBe(1);
    expect(totals.categories.browser_cache.files).toBe(1);
  });

  it("does not cross into another filesystem", async () => {
    const { data, roots } = tree();
    const mounted = join(data, "workspaces", "bot1");
    const fs: WalkFs = {
      opendir: nodeWalkFs.opendir,
      lstat: async (path) => {
        const stat = await nodeWalkFs.lstat(path);
        return path === mounted ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 }) as WalkStat : stat;
      },
    };
    const { totals } = await walkAll(roots, { fs });
    expect(totals.skipped.otherDevice).toBe(1);
    expect(totals.bots.get("bot1")?.files).toBe(1);
  });

  it("takes files and folders deleted during the walk in its stride", async () => {
    const { data, roots } = tree();
    const fs: WalkFs = {
      opendir: async (path) => {
        if (path === join(data, "browser")) rmSync(join(data, "browser"), { recursive: true, force: true });
        return nodeWalkFs.opendir(path);
      },
      lstat: async (path) => {
        if (path === join(data, "messages.db")) rmSync(path);
        return nodeWalkFs.lstat(path);
      },
    };
    const { totals } = await walkAll(roots, { fs });
    expect(totals.skipped.vanished).toBe(2);
    expect(totals.categories.conversations.files).toBe(0);
    expect(totals.categories.bot_files.files).toBe(2);
  });

  it("closes every open folder when closed mid-walk", async () => {
    const { roots } = tree();
    const open = new Set<object>();
    const fs: WalkFs = {
      lstat: nodeWalkFs.lstat,
      opendir: async (path) => {
        const dir = await nodeWalkFs.opendir(path);
        const handle = { read: () => dir.read(), close: async () => { open.delete(handle); await dir.close(); } };
        open.add(handle);
        return handle;
      },
    };
    const walk = createDiskWalk(roots, { fs });
    await walk.step({ entries: 6, stop: () => false });
    expect(open.size).toBeGreaterThan(0);
    await walk.close();
    expect(open.size).toBe(0);
  });

  it("stops at the depth limit and keeps bot tallies and hard links bounded", async () => {
    const { data, roots } = tree();
    for (let index = 0; index < 5; index++) writeFileSync(join(data, "workspaces", `extra${index}`), "x");
    for (let index = 0; index < 4; index++) mkdirSync(join(data, "workspaces", `bot-more-${index}`));
    const { totals } = await walkAll(roots, { maxBots: 2, maxDepth: 3 });
    expect(totals.bots.size).toBe(2);
    expect(totals.botsOverflow.bytes).toBeGreaterThan(0);
    expect(totals.skipped.tooDeep).toBeGreaterThan(0);
  });

  it("measures allocated blocks where the platform has them, a sparse file's included, else the size", () => {
    expect(allocatedBytes({ size: 10, blocks: 8 }, false)).toBe(4096);
    expect(allocatedBytes({ size: 10_000_000, blocks: 8 }, false)).toBe(4096);
    expect(allocatedBytes({ size: 2_147_483_648, blocks: 0 }, false)).toBe(0);
    expect(allocatedBytes({ size: 0, blocks: 0 }, false)).toBe(0);
    expect(allocatedBytes({ size: 10 })).toBe(10);
    expect(allocatedBytes({ size: 10, blocks: 8 }, false)).toBe(4096);
    expect(allocatedBytes({ size: 10, blocks: 0 }, true)).toBe(10);
  });

  it.skipIf(process.platform === "win32")("counts a sparse file by what it takes on disk", async () => {
    const { data, roots } = tree();
    const before = (await walkAll(roots)).totals.walkedBytes;
    truncateSync(join(data, "workspaces", "bot1", "notes.md"), 2_147_483_648);
    const { totals } = await walkAll(roots);
    expect(totals.walkedBytes - before).toBeLessThan(1_000_000);
  });

  it.skipIf(process.platform === "win32")("says how many bytes of hard links went unchecked past the cap", async () => {
    const { data, roots } = tree();
    linkSync(join(data, "messages.db"), join(data, "workspaces", "bot1", "copy.db"));
    const { totals } = await walkAll(roots, { maxLinks: 0 });
    expect(totals.linksCapped).toBe(true);
    expect(totals.linksUncheckedBytes).toBeGreaterThanOrEqual(2 * 10_000);
  });

  it("goes on from any checkpoint to the same totals as one walk, never counting anything twice", async () => {
    const { data, roots } = tree();
    for (let index = 0; index < 4; index++) {
      mkdirSync(join(data, "task-workspaces", "bot1", `t${index + 2}`, "deep", "er"), { recursive: true });
      writeFileSync(join(data, "task-workspaces", "bot1", `t${index + 2}`, "deep", "er", "f"), Buffer.alloc(3_000, 1));
      writeFileSync(join(data, "task-workspaces", "bot1", `t${index + 2}`, "top"), Buffer.alloc(1_000, 1));
    }
    const whole = (await walkAll(roots)).totals;
    const checkpoints: WalkCheckpoint[] = [];
    const first = createDiskWalk(roots, { onBoundary: (take) => { const taken = take(); if (taken) checkpoints.push(JSON.parse(JSON.stringify({ ...taken, totals: totalsJson(taken.totals) }))); } });
    while (!(await first.step({ entries: 1, stop: () => false })));
    expect(checkpoints.length).toBeGreaterThan(5);
    const comparable = (totals: WalkTotals) => ({ ...totalsJson(totals), entries: 0, resumes: 0 });
    for (const saved of checkpoints) {
      const checkpoint = checkpointFrom(saved, roots);
      expect(checkpoint).not.toBeNull();
      const { totals } = await walkAll(roots, { resume: checkpoint });
      expect(totals.resumes).toBe(1);
      expect(comparable(totals)).toEqual(comparable(whole));
    }
  });

  it("refuses a saved checkpoint naming a folder outside the roots or a name with a separator", () => {
    const { home, roots } = tree();
    const totals = totalsJson(createDiskWalk(roots).totals);
    expect(checkpointFrom({ totals, doneRoots: [], frames: [{ path: home, names: ["a"] }] }, roots)).not.toBeNull();
    expect(checkpointFrom({ totals, doneRoots: [], frames: [{ path: "/etc", names: ["a"] }] }, roots)).toBeNull();
    expect(checkpointFrom({ totals, doneRoots: [], frames: [{ path: home, names: ["../x"] }] }, roots)).toBeNull();
    expect(checkpointFrom({ totals, doneRoots: ["/etc"], frames: [] }, roots)).toBeNull();
    expect(checkpointFrom({ totals: { categories: { "acme-merger": { bytes: 1, files: 1 } }, bots: [["Ada's plans", { bytes: 1, files: 1 }]] }, doneRoots: [], frames: [] }, roots)?.totals.bots.size).toBe(0);
  });
});
