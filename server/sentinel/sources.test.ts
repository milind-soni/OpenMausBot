import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { readLogTail, readQueueRecords, readThreadOwners, readToolRecords, readTurnRecords, type LogOffset } from "./sources.ts";
import { fixtureDataDir, turnCompleted, type FixtureDataDir } from "./testing.ts";

describe("sentinel sources", () => {
  let dir: string;
  let fixture: FixtureDataDir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-sentinel-src-"));
    fixture = fixtureDataDir(dir, [{ id: "b1", name: "Probe", threadId: "t1", tasks: [{ threadId: "t2" }] }]);
  });
  afterEach(() => {
    fixture.close();
    removeTempDir(dir);
  });

  it("reads uncheckpointed WAL rows read-only, and leaves the live database exactly as it was", () => {
    fixture.activity({ threadId: "t1", id: "m1", at: 1_000, name: "mcp__agents__send", ok: false, output: "no layer 12", turnId: "u1" });
    fixture.activity({ threadId: "t2", id: "m2", at: 1_100, name: "Bash", ok: true, output: "hi" });
    fixture.activity({ threadId: "t2", id: "m3", at: 1_200, name: "Bash" }); // still running: no outcome yet
    fixture.activity({ threadId: "g1", id: "m4", at: 1_300, name: "Read", ok: false, output: "denied", from: { botId: "b9", name: "Other" } });
    const main = statSync(join(dir, "messages.db"));
    const wal = statSync(join(dir, "messages.db-wal"));
    expect(wal.size).toBeGreaterThan(0);

    const records = readToolRecords(dir, 0, readThreadOwners(dir));
    expect(records.map((r) => [r.id, r.botId])).toEqual([["m1", "b1"], ["m4", "b9"]]);
    expect(records[0]).toMatchObject({ type: "tool", tool: "mcp__agents__send", ok: false, text: "no layer 12", turnId: "u1", threadId: "t1" });
    // no write, no checkpoint: the rows are still only in the -wal
    expect(statSync(join(dir, "messages.db")).size).toBe(main.size);
    expect(statSync(join(dir, "messages.db")).mtimeMs).toBe(main.mtimeMs);
    expect(statSync(join(dir, "messages.db-wal")).size).toBe(wal.size);
    // and the app can keep writing
    fixture.activity({ threadId: "t1", id: "m5", at: 1_500, name: "Bash", ok: false, output: "exit 1" });
    expect(readToolRecords(dir, 1_400, readThreadOwners(dir)).map((r) => r.id)).toEqual(["m5"]);
  });

  it("picks up a tool's outcome when its row is updated after the first read", () => {
    fixture.activity({ threadId: "t1", id: "m1", at: 1_000, name: "Bash" });
    expect(readToolRecords(dir, 0, readThreadOwners(dir))).toEqual([]);
    fixture.activity({ threadId: "t1", id: "m1", at: 1_000, name: "Bash", ok: false, output: "exit 2" });
    expect(readToolRecords(dir, 0, readThreadOwners(dir)).map((r) => r.id)).toEqual(["m1"]);
  });

  it("keeps a harness notice's sentence out of the tool name and takes bot names out of it", () => {
    fixture.activity({ threadId: "t1", id: "m1", at: 1_000, name: "Probe's room turn exceeded 20 minutes and was stopped", ok: false });
    const [record] = readToolRecords(dir, 0, readThreadOwners(dir));
    expect(record).toMatchObject({ tool: "harness_notice", text: "<bot>'s room turn exceeded 20 minutes and was stopped" });
  });

  it("reads only new whole lines of an event log, and starts over when the file is replaced or truncated", () => {
    const file = join(dir, "events", "t1.ndjson");
    writeFileSync(file, `${turnCompleted({ eventId: "e1", threadId: "t1", at: 1_000 })}\n{"type":"turn.comp`);
    const first = readLogTail(file, undefined)!;
    expect(first.lines).toHaveLength(1);
    let offset: LogOffset = { ...first.offset, hwm: 1_000 };
    // the half-written record is read once it is whole
    appendFileSync(file, `leted"}\n`);
    const second = readLogTail(file, offset)!;
    expect(second.lines).toEqual(['{"type":"turn.completed"}']);
    offset = second.offset;
    expect(readLogTail(file, offset)!.lines).toEqual([]);

    // rotation: rewritten through a rename (a new inode), keeping the tail
    const kept = `${turnCompleted({ eventId: "e1", threadId: "t1", at: 1_000 })}\n${turnCompleted({ eventId: "e2", threadId: "t1", at: 2_000 })}\n`;
    writeFileSync(`${file}.trim`, kept);
    renameSync(`${file}.trim`, file);
    const rotated = readLogTail(file, offset)!;
    expect(rotated.lines).toHaveLength(2);
    expect(rotated.skipThrough).toBe(1_000);

    // truncation in place: same inode, smaller than the offset
    const before = statSync(file).ino;
    writeFileSync(file, `${turnCompleted({ eventId: "e3", threadId: "t1", at: 3_000 })}\n`);
    expect(statSync(file).ino).toBe(before);
    const truncated = readLogTail(file, { ino: before, offset: 10_000, hwm: 2_000 })!;
    expect(truncated.lines).toHaveLength(1);
    expect(truncated.offset.offset).toBe(statSync(file).size);
  });

  it("counts each turn.completed once across rotation and deletion of its log", () => {
    const file = join(dir, "events", "t1.ndjson");
    writeFileSync(file, [
      turnCompleted({ eventId: "e1", threadId: "t1", turnId: "u1", at: 1_000, ok: false, stopReason: "error" }),
      JSON.stringify({ type: "content.delta", eventId: "x", threadId: "t1", createdAt: new Date(1_100).toISOString() }),
      turnCompleted({ eventId: "e2", threadId: "t1", at: 2_000, cost: 9 }),
    ].join("\n") + "\n");
    const who = readThreadOwners(dir);
    const first = readTurnRecords(dir, {}, who);
    expect(first.records.map((r) => r.id)).toEqual(["e1", "e2"]);
    expect(first.records[0]).toMatchObject({ type: "turn", ok: false, stopReason: "error", turnId: "u1", botId: "b1" });
    expect(first.offsets["t1.ndjson"]!.hwm).toBe(2_000);

    // rewritten by rotation with e2 kept and e3 new: only e3 is new
    writeFileSync(`${file}.trim`, `${turnCompleted({ eventId: "e2", threadId: "t1", at: 2_000 })}\n${turnCompleted({ eventId: "e3", threadId: "t1", at: 3_000 })}\n`);
    renameSync(`${file}.trim`, file);
    const second = readTurnRecords(dir, first.offsets, who);
    expect(second.records.map((r) => r.id)).toEqual(["e3"]);

    // retention deleted it: the offset is dropped, nothing breaks
    rmSync(file);
    const third = readTurnRecords(dir, second.offsets, who);
    expect(third).toEqual({ records: [], offsets: {} });
    expect(existsSync(file)).toBe(false);
  });

  it("measures queue waits from enqueued or resume_due to started, and reports one still waiting", () => {
    fixture.assignment({ id: "a1", status: "completed", botId: "b1", threadId: "t1", events: [{ kind: "enqueued", at: 1_000 }, { kind: "started", at: 401_000 }, { kind: "resume_due", at: 500_000 }, { kind: "started", at: 510_000 }] });
    fixture.assignment({ id: "a2", status: "queued", botId: "b1", threadId: "t2", events: [{ kind: "enqueued", at: 600_000 }] });
    fixture.assignment({ id: "a3", status: "completed", botId: "b1", threadId: "t2", events: [{ kind: "enqueued", at: 10 }, { kind: "started", at: 20 }] });
    const records = readQueueRecords(dir, 100, 1_000_000, readThreadOwners(dir));
    expect(records.map((r) => r.type === "queue" && [r.assignmentId, r.waitMs, r.started])).toEqual([
      ["a1", 400_000, true],
      ["a1", 10_000, true],
      ["a2", 400_000, false],
    ]);
    // the same wait keeps its id from waiting to started
    const pending = records[2]!.id;
    fixture.runtime.prepare("INSERT INTO assignment_events (assignment_id, at, kind) VALUES ('a2', 1100000, 'started')").run();
    fixture.runtime.prepare("UPDATE assignments SET status = 'running' WHERE id = 'a2'").run();
    const started = readQueueRecords(dir, 100, 1_200_000, readThreadOwners(dir)).filter((r) => r.type === "queue" && r.assignmentId === "a2");
    expect(started).toMatchObject([{ id: pending, waitMs: 500_000, started: true }]);
  });

  it("treats a missing or unreadable source as empty", () => {
    const empty = mkdtempSync(join(tmpdir(), "omb-sentinel-empty-"));
    try {
      const who = readThreadOwners(empty);
      expect(who.owners.size).toBe(0);
      expect(readToolRecords(empty, 0, who)).toEqual([]);
      expect(readTurnRecords(empty, {}, who)).toEqual({ records: [], offsets: {} });
      expect(readQueueRecords(empty, 0, 0, who)).toEqual([]);
      expect(existsSync(join(empty, "messages.db"))).toBe(false);
      writeFileSync(join(empty, "bots.json"), "{not json");
      expect(readThreadOwners(empty).owners.size).toBe(0);
    } finally {
      removeTempDir(empty);
    }
    expect(readFileSync(join(dir, "bots.json"), "utf8")).toContain("b1");
  });
});
