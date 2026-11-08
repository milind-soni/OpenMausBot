import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStarterAwake, STARTER_AWAKE_FILE, type AwakeBot } from "./starter-awake.ts";

const dirs: string[] = [];
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "starter-awake-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Bot `b<n>` was last active at minute n. */
const bots = (count: number): AwakeBot[] => Array.from({ length: count }, (_, n) => ({ id: `b${n}`, createdAt: 0, tasks: [{ updatedAt: n * 60_000 }] }));

describe("which of a Starter Cloud's bots stay awake", () => {
  it("keeps the five most recently active awake and pauses the rest, written down so a message never reshuffles them", () => {
    const dir = dataDir(), list = bots(8);
    const awake = createStarterAwake({ dataDir: dir, starter: () => true, bots: () => list });
    expect(awake.limit()).toBe(5);
    expect(awake.paused()).toEqual(["b0", "b1", "b2"]);
    expect(JSON.parse(readFileSync(join(dir, STARTER_AWAKE_FILE), "utf8")).awake).toEqual(["b7", "b6", "b5", "b4", "b3"]);
    // A paused bot gets a message: it stays paused.
    list[0]!.tasks = [{ updatedAt: 99 * 60_000 }];
    expect(awake.isPaused("b0")).toBe(true);
    // And a restart reads the same set.
    expect(createStarterAwake({ dataDir: dir, starter: () => true, bots: () => list }).paused()).toEqual(["b0", "b1", "b2"]);
  });

  it("pauses nobody within the limit, off Starter, or the MausBot and chief of staff", () => {
    expect(createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => bots(5) }).paused()).toEqual([]);
    const off = createStarterAwake({ dataDir: dataDir(), starter: () => false, bots: () => bots(30) });
    expect([off.limit(), off.paused()]).toEqual([undefined, []]);
    const list: AwakeBot[] = [...bots(5), { id: "maus", defaultBot: {}, createdAt: 0 }, { id: "chief", chiefOfStaff: true, createdAt: 0 }, { id: "gone", hidden: true, createdAt: 0 }];
    expect(createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => list }).paused()).toEqual([]);
  });

  it("swaps in the person's choice, refusing anything but this Cloud's bots in the plan's number", () => {
    let changed = 0;
    const awake = createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => bots(7), changed: () => { changed++; } });
    expect(awake.choose(["b0", "b1", "b2", "b3"])).toMatchObject({ ok: false });
    expect(awake.choose(["b0", "b1", "b2", "b3", "nope"])).toMatchObject({ ok: false });
    expect(awake.choose(["b0", "b1", "b2", "b3", "b4"])).toEqual({ ok: true });
    expect([awake.paused(), changed]).toEqual([["b5", "b6"], 1]);
  });

  it("fills a chosen bot that was deleted from the most recently active, and reads a damaged file as no choice", () => {
    const dir = dataDir();
    writeFileSync(join(dir, STARTER_AWAKE_FILE), JSON.stringify({ v: 1, awake: ["b0", "b1", "b2", "b3", "deleted"] }));
    expect(createStarterAwake({ dataDir: dir, starter: () => true, bots: () => bots(7) }).paused()).toEqual(["b4", "b5"]);
    writeFileSync(join(dir, STARTER_AWAKE_FILE), "not json");
    expect(createStarterAwake({ dataDir: dir, starter: () => true, bots: () => bots(7) }).paused()).toEqual(["b0", "b1"]);
  });

  it("wakes every bot at once on an upgrade", () => {
    let starter = true;
    const awake = createStarterAwake({ dataDir: dataDir(), starter: () => starter, bots: () => bots(9) });
    expect(awake.paused()).toHaveLength(4);
    starter = false;
    expect(awake.paused()).toEqual([]);
  });
});
