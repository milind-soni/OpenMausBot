import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LEDGER_KEEP_ALL_MS, LEDGER_KEEP_PER_ROUTINE, ledgerPaths, loadOccurrence, RoutineLedger, type Occurrence } from "./routine-ledger.ts";

const START = Date.parse("2026-11-16T08:00:00Z"), HOUR = 3_600_000;
const dirs: string[] = [];

function world(start = START) {
  const dir = mkdtempSync(join(tmpdir(), "omb-ledger-"));
  dirs.push(dir);
  const routines = join(dir, "routines.json"), clock = { now: start };
  const open = () => { const ledger = new RoutineLedger(routines, () => clock.now, 40); return { ledger, opened: ledger.open() }; };
  return { ...ledgerPaths(routines), clock, open };
}

const ran = (dueAt: number, more: Partial<Occurrence> = {}): Occurrence =>
  ({ routineId: "routine-1", dueAt, state: "ran", attempts: 1, startedAt: dueAt, madeAt: dueAt, endedAt: dueAt + 60_000, runIds: [`run-${dueAt}`], ...more });

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the ledger file", () => {
  it("reads back what was appended, the last line for a key winning, and keeps its sequence number", () => {
    const w = world(), { ledger, opened } = w.open();
    expect(opened).toEqual({ state: "missing", restoredThrough: null });
    ledger.write([{ ...ran(START), state: "queued", attempts: 0, startedAt: undefined, endedAt: undefined }]);
    ledger.write([ran(START)]);
    ledger.write([ran(START + HOUR, { state: "missed", attempts: 0, count: 3, lastAt: START + 3 * HOUR })]);
    expect(ledger.seq).toBe(3);

    const again = w.open();
    expect(again.opened).toEqual({ state: "ok", restoredThrough: null });
    expect(again.ledger.seq).toBe(3);
    expect(again.ledger.get("routine-1", START)).toMatchObject({ state: "ran", attempts: 1 });
    expect(again.ledger.ofRun(`run-${START}`)?.dueAt).toBe(START);
    expect(again.ledger.covering("routine-1", START + 2 * HOUR)?.dueAt).toBe(START + HOUR);
    expect(again.ledger.covering("routine-1", START + 4 * HOUR)).toBeUndefined();
    expect(again.ledger.covering("routine-2", START)).toBeUndefined();
    expect(again.ledger.size).toBe(2);
  });

  it("drops a record whose removal was written, and a lease is renewed without raising the sequence number", () => {
    const w = world(), { ledger } = w.open();
    const queued: Occurrence = { ...ran(START), state: "queued", attempts: 0, startedAt: undefined, endedAt: undefined };
    ledger.write([queued, ran(START + HOUR, { state: "running", endedAt: undefined, lease: { machine: "m", boot: "b", until: START + 1 }})]);
    ledger.write([], [queued]);
    const seq = ledger.seq;
    ledger.write([ran(START + HOUR, { state: "running", endedAt: undefined, lease: { machine: "m", boot: "b", until: START + 2 } })], [], false);
    expect(ledger.seq).toBe(seq);
    const again = w.open().ledger;
    expect(again.seq).toBe(seq);
    expect([...again.all()]).toMatchObject([{ dueAt: START + HOUR, lease: { until: START + 2 } }]);
    expect(again.ofRun(`run-${START}`)).toBeUndefined();
  });

  it("keeps every whole line of a file whose last line was torn, and its next append starts a new line", () => {
    const w = world(), { ledger } = w.open();
    ledger.write([ran(START)]);
    writeFileSync(w.ledger, `${readFileSync(w.ledger, "utf8")}{"s":2,"o":{"routineId":"rout`);
    const torn = w.open();
    expect(torn.opened.state).toBe("damaged");
    expect([...torn.ledger.all()]).toHaveLength(1);
    torn.ledger.write([ran(START + HOUR)]);
    const again = w.open();
    expect(again.opened.state).toBe("ok");
    expect([...again.ledger.all()].map((record) => record.dueAt)).toEqual([START, START + HOUR]);
    expect(again.ledger.seq).toBe(3);
  });

  it("drops a line that is not a record, and nothing else", () => {
    const w = world();
    writeFileSync(w.ledger, [JSON.stringify({ v: 1, s: 9 }), JSON.stringify({ s: 10, o: ran(START) }), "not json", JSON.stringify({ s: 11, o: { ...ran(START + HOUR), state: "exploded" } }),
      JSON.stringify({ s: 12, o: { ...ran(START + 2 * HOUR), routineId: "../../etc/passwd" } }), JSON.stringify({ o: ran(START + 3 * HOUR) }), ""].join("\n"));
    const { ledger, opened } = w.open();
    expect(opened.state).toBe("damaged");
    expect([...ledger.all()].map((record) => record.dueAt)).toEqual([START]);
    expect(ledger.seq).toBe(12);
    expect(loadOccurrence({ ...ran(START), count: 1, lastAt: START - 1, reason: "made-up", lease: { machine: "m" } })).toEqual(ran(START));
  });

  it("is rewritten whole once it has grown, keeps what is not ended, and lets old ended records go routine by routine", () => {
    const w = world(START + 100 * 24 * HOUR), { ledger } = w.open();
    const old = Array.from({ length: LEDGER_KEEP_PER_ROUTINE + 40 }, (_, index) => ran(START + index * HOUR));
    ledger.write(old);
    ledger.write([ran(START - HOUR, { routineId: "routine-2" }), { ...ran(START - 2 * HOUR, { routineId: "routine-3" }), state: "queued", attempts: 0, endedAt: undefined }]);
    const recent = Array.from({ length: 30 }, (_, index) => ran(w.clock.now - LEDGER_KEEP_ALL_MS + (index + 1) * 60_000, { routineId: "routine-4" }));
    ledger.write(recent);
    for (let changes = 0; changes < 50; changes += 1) ledger.write([], [], true);
    const lines = readFileSync(w.ledger, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(60);
    expect(JSON.parse(lines[0]!)).toMatchObject({ v: 1 });

    const again = w.open();
    expect(again.opened.state).toBe("ok");
    expect(again.ledger.seq).toBe(ledger.seq);
    expect(again.ledger.ofRoutine("routine-1")).toHaveLength(0);
    expect(again.ledger.ofRoutine("routine-2")).toHaveLength(0);
    expect(again.ledger.ofRoutine("routine-3")).toMatchObject([{ state: "queued" }]);
    expect(again.ledger.ofRoutine("routine-4")).toHaveLength(30);
  });

  it("keeps each routine's newest ended records past two days, however many another routine makes", () => {
    const w = world(START + 10 * 24 * HOUR), { ledger } = w.open();
    ledger.write(Array.from({ length: LEDGER_KEEP_PER_ROUTINE + 60 }, (_, index) => ran(START + index * 300_000, { routineId: "every-five-minutes" })));
    ledger.write([ran(START), ran(START + 24 * HOUR)]);
    for (let changes = 0; changes < 50; changes += 1) ledger.write([], [], true);
    const again = w.open().ledger;
    expect(again.ofRoutine("every-five-minutes")).toHaveLength(LEDGER_KEEP_PER_ROUTINE);
    expect(again.get("every-five-minutes", START)).toBeUndefined();
    expect(again.ofRoutine("routine-1")).toHaveLength(2);
  });
});

describe("the mark beside the ledger", () => {
  it("tells a ledger brought back from a backup by its lower sequence number, and until when the newer one was alive", () => {
    const w = world(), { ledger } = w.open();
    ledger.write([ran(START)]);
    const backup = readFileSync(w.ledger, "utf8");
    w.clock.now = START + 2 * HOUR;
    ledger.write([ran(START + HOUR)]);
    ledger.write([ran(START + 2 * HOUR)]);

    writeFileSync(w.ledger, backup);
    w.clock.now = START + 5 * HOUR;
    const restored = w.open();
    expect(restored.opened).toEqual({ state: "ok", restoredThrough: START + 2 * HOUR });
    expect(restored.ledger.seq).toBe(1);
    restored.ledger.write([ran(START + 5 * HOUR)]);
    expect(w.open().opened.restoredThrough).toBeNull();
  });

  it("carries the sequence number past a ledger that is lost or damaged, and takes neither for a restore", () => {
    const w = world(), { ledger } = w.open();
    for (const hour of [0, 1, 2]) ledger.write([ran(START + hour * HOUR)]);
    rmSync(w.ledger);
    const lost = w.open();
    expect(lost.opened).toEqual({ state: "missing", restoredThrough: null });
    expect(lost.ledger.seq).toBe(4);
    lost.ledger.write([ran(START)]);
    const seq = lost.ledger.seq;

    writeFileSync(w.ledger, "garbage\n");
    const damaged = w.open();
    expect(damaged.opened).toEqual({ state: "damaged", restoredThrough: null });
    expect(damaged.ledger.seq).toBeGreaterThan(seq);
    rmSync(w.mark);
    expect(w.open().opened.restoredThrough).toBeNull();
  });

  it("takes an empty ledger for a lost one, never for a restore", () => {
    const w = world(), { ledger } = w.open();
    for (const hour of [0, 1, 2]) ledger.write([ran(START + hour * HOUR)]);
    for (const empty of ["", "\n", "  \n"]) {
      writeFileSync(w.ledger, empty);
      const opened = w.open();
      expect(opened.opened).toEqual({ state: "missing", restoredThrough: null });
      expect(opened.ledger.seq).toBe(4);
      expect(opened.ledger.sync()).toBe(false);
    }
  });

  it("reads the file again only when another process has written to it", () => {
    const w = world(), mine = w.open().ledger;
    mine.write([ran(START)]);
    expect(mine.sync()).toBe(false);
    const theirs = w.open().ledger;
    theirs.write([ran(START + HOUR)]);
    expect(mine.sync()).toBe(true);
    expect(mine.get("routine-1", START + HOUR)).toMatchObject({ state: "ran" });
    expect(mine.seq).toBe(theirs.seq);
    expect(mine.sync()).toBe(false);
  });

  it("leaves memory as it was when a write fails, and when the file cannot be read again", () => {
    const w = world(), { ledger } = w.open();
    ledger.write([ran(START)]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A folder where the file should be: neither an append nor a read works, on Windows as on any other system.
    rmSync(w.ledger);
    mkdirSync(w.ledger);
    expect(() => ledger.write([ran(START + HOUR)])).toThrow();
    ledger.sync();
    expect(ledger.seq).toBe(1);
    expect([...ledger.all()].map((record) => record.dueAt)).toEqual([START]);
    rmSync(w.ledger, { recursive: true });
    ledger.write([ran(START + HOUR)]);
    expect(w.open().ledger.get("routine-1", START + HOUR)).toBeDefined();
  });
});
