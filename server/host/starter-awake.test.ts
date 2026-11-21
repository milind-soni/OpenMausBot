import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStarterAwake, STARTER_AWAKE_FILE, STARTER_SWAP_MIN_IDLE_MS, type AwakeBot } from "./starter-awake.ts";

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

  it("starts a sixth bot and a twentieth paused, and never pauses one the person was using to make room", () => {
    const dir = dataDir(), list = bots(4);
    const awake = createStarterAwake({ dataDir: dir, starter: () => true, bots: () => list });
    const make = (id: string) => { list.unshift({ id, createdAt: Date.now(), tasks: [{ updatedAt: Date.now() }] }); return awake.paused(); };
    expect(make("fifth")).toEqual([]);
    expect(make("sixth")).toEqual(["sixth"]);
    for (let n = 7; n <= 20; n++) make(`bot${n}`);
    expect(awake.paused()).toHaveLength(15);
    expect(awake.paused()).toEqual(expect.arrayContaining(["sixth", "bot7", "bot20"]));
    expect(new Set(list.map((bot) => bot.id).filter((id) => !awake.isPaused(id)))).toEqual(new Set(["b0", "b1", "b2", "b3", "fifth"]));
    // A restart reads the same five.
    expect(createStarterAwake({ dataDir: dir, starter: () => true, bots: () => list }).paused()).toHaveLength(15);
  });

  it("swaps a new bot in for one the person picks, keeping five awake", () => {
    const list = bots(5);
    const awake = createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => list });
    expect(awake.paused()).toEqual([]);
    list.unshift({ id: "new", createdAt: Date.now() });
    expect(awake.paused()).toEqual(["new"]);
    expect(awake.choose(["new", "b1", "b2", "b3", "b4"])).toEqual({ ok: true });
    expect(awake.paused()).toEqual(["b0"]);
  });

  it("gives a freed place to a bot already paused, not to the next one made", () => {
    const list = bots(5);
    const awake = createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => list });
    awake.paused();
    list.unshift({ id: "sixth", createdAt: Date.now() });
    expect(awake.paused()).toEqual(["sixth"]);
    list.splice(list.findIndex((bot) => bot.id === "b2"), 1);
    expect(awake.paused()).toEqual([]);
  });

  it("wakes every bot at once on an upgrade", () => {
    let starter = true;
    const awake = createStarterAwake({ dataDir: dataDir(), starter: () => starter, bots: () => bots(9) });
    expect(awake.paused()).toHaveLength(4);
    starter = false;
    expect(awake.paused()).toEqual([]);
  });
});

describe("a routine's bot on a Starter Cloud", () => {
  /** Seven bots: b2–b6 awake (written down before any routine), b0 and b1 paused; `routines` have an enabled routine and
   * `busy` are working. */
  const seven = (dir = dataDir(), routines: string[] = ["b0"], busy: string[] = [], options: { held?: string[]; now?: number } = {}) => {
    const awake = createStarterAwake({ dataDir: dir, starter: () => true, bots: () => bots(7), ...(options.now === undefined ? {} : { now: () => options.now! }) });
    awake.paused();
    awake.useRoutines({ routineBots: () => new Set(routines), busy: (id) => busy.includes(id), held: (id) => (options.held ?? []).includes(id) });
    return awake;
  };
  const written = (dir: string) => JSON.parse(readFileSync(join(dir, STARTER_AWAKE_FILE), "utf8"));

  it("wakes it in place of the awake bot with no routine that was idle longest, written down so the picker and a restart see it", () => {
    const dir = dataDir(), awake = seven(dir);
    expect(awake.paused()).toEqual(["b0", "b1"]);
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "woke", out: "b2" });
    expect(awake.paused()).toEqual(["b1", "b2"]);
    expect(written(dir).awake).toEqual(expect.arrayContaining(["b0", "b3", "b4", "b5", "b6"]));
    expect(createStarterAwake({ dataDir: dir, starter: () => true, bots: () => bots(7) }).paused()).toEqual(["b1", "b2"]);
    // Awake now: its next run changes nothing.
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "awake" });
  });

  it("never pauses a bot that is working, has a routine of its own, or was paused by the person, to make room", () => {
    const awake = seven(dataDir(), ["b0", "b2"], ["b3"], { held: ["b4"] });
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "woke", out: "b5" });
    expect(awake.paused()).toEqual(["b1", "b5"]);
  });

  it("takes the place only of a bot idle for an hour or more; otherwise the routine runs and its bot stays paused", () => {
    // b2–b6 were last active at minutes 2–6.
    const minute = 60_000, hour = STARTER_SWAP_MIN_IDLE_MS;
    expect(hour).toBe(60 * minute);
    expect(seven(dataDir(), ["b0"], [], { now: 2 * minute + hour - 1 }).wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "full", first: true });
    expect(seven(dataDir(), ["b0"], [], { now: 2 * minute + hour }).wakeForRoutine("b0", true)).toEqual({ kind: "woke", out: "b2" });
    // b3 is idle long enough, b2 is not counted as it works: b3 goes.
    expect(seven(dataDir(), ["b0"], ["b2"], { now: 3 * minute + hour }).wakeForRoutine("b0", true)).toEqual({ kind: "woke", out: "b3" });
    expect(seven(dataDir(), ["b0"], ["b2"], { now: 3 * minute + hour - 1 }).wakeForRoutine("b0", true)).toMatchObject({ kind: "ran", why: "full" });
  });

  it("runs the routine without changing who is awake when every awake bot has a routine or is working, telling once, across a restart", () => {
    const dir = dataDir(), all = ["b0", "b1", "b2", "b3", "b4", "b5", "b6"];
    const awake = seven(dir, all);
    expect(awake.wakeForRoutine("b0", false)).toEqual({ kind: "ran", why: "full", first: false });
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "full", first: true });
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "full", first: false });
    expect(awake.wakeForRoutine("b1", true)).toEqual({ kind: "ran", why: "full", first: true });
    expect(seven(dir, all).wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "full", first: false });
    expect(awake.paused()).toEqual(["b0", "b1"]);
    expect(seven(dataDir(), ["b0"], ["b2", "b3", "b4", "b5", "b6"]).wakeForRoutine("b0", true)).toMatchObject({ kind: "ran", why: "full" });
  });

  it("keeps the person's later choice: a routine bot they leave paused stays paused and its routine still runs", () => {
    const dir = dataDir(), routines = ["b0"], awake = seven(dir, routines);
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "woke", out: "b2" });
    expect(awake.choose(["b2", "b3", "b4", "b5", "b6"])).toEqual({ ok: true });
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "chosen", first: true });
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "chosen", first: false });
    expect(awake.paused()).toEqual(["b0", "b1"]);
    // Across a restart too.
    expect(seven(dir, routines).wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "chosen", first: false });
    // b1 had no routine when they chose, so a routine made for it later wakes it.
    routines.push("b1");
    expect(awake.wakeForRoutine("b1", false)).toEqual({ kind: "woke", out: "b2" });
    // Choosing b0 again lets it be woken later.
    expect(awake.choose(["b0", "b1", "b4", "b5", "b6"])).toEqual({ ok: true });
    expect(written(dir).left).toBeUndefined();
  });

  it("swaps nothing for a bot with no enabled routine, as when one switched off is run by hand", () => {
    const awake = seven(dataDir(), []);
    expect(awake.wakeForRoutine("b0", true)).toEqual({ kind: "ran", why: "off", first: true });
    expect(awake.paused()).toEqual(["b0", "b1"]);
  });

  it("gives a freed place, or a first choice, to a paused bot with a routine before a more recently active one", () => {
    const list = bots(7), awake = createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => list });
    expect(awake.paused()).toEqual(["b0", "b1"]);
    awake.useRoutines({ routineBots: () => new Set(["b0"]), busy: () => false, held: () => false });
    list.splice(list.findIndex((bot) => bot.id === "b4"), 1);
    expect(awake.paused()).toEqual(["b1"]);
    const fresh = createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => bots(7) });
    fresh.useRoutines({ routineBots: () => new Set(["b0"]), busy: () => false, held: () => false });
    expect(fresh.paused()).toEqual(["b1", "b2"]);
  });

  it("changes nothing off Starter, within the limit, or for a bot the limit does not count", () => {
    const off = createStarterAwake({ dataDir: dataDir(), starter: () => false, bots: () => bots(9) });
    off.useRoutines({ routineBots: () => new Set(["b0"]), busy: () => false, held: () => false });
    expect([off.wakeForRoutine("b0", true), off.paused()]).toEqual([{ kind: "awake" }, []]);
    const few = createStarterAwake({ dataDir: dataDir(), starter: () => true, bots: () => bots(5) });
    expect(few.wakeForRoutine("b0", true)).toEqual({ kind: "awake" });
    expect(seven().wakeForRoutine("chief", true)).toEqual({ kind: "awake" });
  });
});
