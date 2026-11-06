import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openRunJournal, runJournalFile } from "./routine-run-journal.ts";
import type { RoutineRun } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-run-journal-"));
  dirs.push(dir);
  const routines = join(dir, "routines.json");
  return { routines, journal: runJournalFile(routines) };
}

const run = (id: string, status: RoutineRun["status"] = "queued"): RoutineRun => ({
  id, routineId: "r1", routineName: "Report", target: "bot", botId: "b1", runOn: "maus",
  scheduledFor: 1, status, manual: true, createdAt: 1,
});

describe("the run journal", () => {
  it("writes only the runs that changed and a tombstone for one that went", () => {
    const { journal } = fixture();
    const store = openRunJournal(journal);
    store.load([]);
    store.write([run("a"), run("b")]);
    const first = readFileSync(journal, "utf8");
    expect(first.trim().split("\n")).toHaveLength(2);

    store.write([run("a"), run("b")]);
    expect(readFileSync(journal, "utf8")).toBe(first);

    store.write([{ ...run("a"), status: "running" }, run("b")]);
    expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(3);

    store.write([run("b")]);
    const lines = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ v: 1, drop: "a" });
  });

  it("reloads the latest snapshot for each run, in first-seen order", () => {
    const { journal } = fixture();
    const first = openRunJournal(journal);
    first.load([]);
    first.write([run("a"), run("b")]);
    first.write([{ ...run("b"), status: "completed" }, { ...run("a"), status: "running" }]);

    const second = openRunJournal(journal);
    const { runs, migrated } = second.load([]);
    expect(migrated).toBe(false);
    expect(runs.map((each) => [each.id, each.status])).toEqual([["a", "running"], ["b", "completed"]]);
  });

  it("moves runs still in routines.json into the log, and the log's newer copy wins", () => {
    const { journal } = fixture();
    const first = openRunJournal(journal);
    first.load([]);
    first.write([{ ...run("a"), status: "completed" }]);

    const opened = openRunJournal(journal);
    const { runs, migrated } = opened.load([{ ...run("a"), status: "queued" }, run("b")]);
    expect(migrated).toBe(true);
    expect(runs.map((each) => [each.id, each.status])).toEqual([["a", "completed"], ["b", "queued"]]);

    // The migration save writes b (a is already in the log) and then keeps both.
    opened.write(runs);
    expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(2);
    expect(openRunJournal(journal).load([]).runs.map((each) => each.id)).toEqual(["a", "b"]);
  });

  it("cuts a torn last line so the next append starts cleanly", () => {
    const { journal } = fixture();
    const store = openRunJournal(journal);
    store.load([]);
    store.write([run("a")]);
    const whole = readFileSync(journal, "utf8");
    writeFileSync(journal, `${whole}{"v":1,"run":{"id":"tor`);

    const opened = openRunJournal(journal);
    expect(opened.load([]).runs.map((each) => each.id)).toEqual(["a"]);
    opened.write([run("a"), run("b")]);
    expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("rewrites the log as one line per run when compacted", () => {
    const { journal } = fixture();
    const store = openRunJournal(journal);
    store.load([]);
    for (let i = 0; i < 5; i++) store.write([{ ...run("a"), status: i % 2 ? "queued" : "running" }]);
    expect(statSync(journal).size).toBeGreaterThan(1);
    store.compact([{ ...run("a"), status: "completed" }]);
    const lines = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ v: 1, run: expect.objectContaining({ id: "a", status: "completed" }) }]);
  });
});
