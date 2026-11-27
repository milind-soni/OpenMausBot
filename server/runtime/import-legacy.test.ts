import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { importLegacyDelegations, importLegacyHandoffs, type LegacyThreadResolver } from "./import-legacy.ts";
import { checkInvariants } from "./invariants.ts";
import { openRuntimeStore } from "./store.ts";
import { Runtime } from "./runtime.ts";
import type { Assignment, TurnRunner } from "./types.ts";

const T0 = 1_700_000_000_000;
const legacy = [
  { id: "gen-1", rootId: "gen-1", threadId: "chief-chat", botId: "chief", key: "root", text: "Ship it", createdAt: T0, status: "source",
    result: "", reported: true, executions: 0, approvalGranted: false, kind: "work", origin: { kind: "user", request: "Ship it" }, restarts: 0 },
  { id: "c-run", rootId: "gen-1", parentId: "gen-1", threadId: "builder-work", botId: "builder", key: "builder", text: "Build it", createdAt: T0 + 1,
    status: "running", result: "", reported: false, executions: 1, startedAt: T0 + 2, approvalGranted: true, kind: "work", restarts: 0 },
  { id: "c-done", rootId: "gen-1", parentId: "gen-1", threadId: "tester-work", botId: "tester", key: "tester", text: "Test it", createdAt: T0 + 3,
    status: "completed", result: "All green", reported: true, executions: 1, lastProgressAt: T0 + 9, approvalGranted: false, kind: "work", restarts: 0 },
  { id: "c-queued", rootId: "gen-1", parentId: "gen-1", groupId: "g1", threadId: "room-1", botId: "writer", key: "writer", text: "Write it", createdAt: T0 + 4,
    status: "queued", result: "", reported: false, executions: 0, approvalGranted: false, kind: "work", requestBatchKey: "b1", restarts: 0 },
];

const idleRunner: TurnRunner = {
  validate: () => undefined, canStart: () => false, run: async () => ({ kind: "completed", text: "" }),
  park: () => {}, report: () => {}, changed: () => {}, names: (a) => ({ requester: "Chief", assignee: a.assignee.botId }),
};

describe("importLegacyHandoffs", () => {
  it("brings a room-handoff tree over once, keeps ids and lineage, and renames the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-import-"));
    const file = join(dir, "room-handoffs.json");
    writeFileSync(file, JSON.stringify(legacy));
    const store = openRuntimeStore(":memory:");
    expect(importLegacyHandoffs(store, file, T0 + 100)).toBe(4);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.migrated`)).toBe(true);
    const root = store.get("gen-1")!;
    expect(root).toMatchObject({ status: "running", depth: 0, executions: 1, origin: { kind: "person", quote: "Ship it" },
      requester: { kind: "person", threadId: "chief-chat" }, assignee: { destination: { kind: "standing_thread", threadId: "chief-chat" } } });
    expect(store.get("c-run")).toMatchObject({ status: "running", depth: 1, parentId: "gen-1", approved: true, brief: "Build it",
      requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat" }, assignee: { destination: { kind: "work_thread" } } });
    expect(store.get("c-done")).toMatchObject({ status: "completed", outcome: "done", result: "All green" });
    expect(store.get("c-done")!.reportedAt).toBeDefined();
    expect(store.get("c-queued")).toMatchObject({ status: "queued", batchKey: "b1", assignee: { destination: { kind: "room_thread", groupId: "g1" } } });
    expect(store.events("c-run").map((e) => e.kind)).toEqual(["enqueued", "started"]);
    expect(importLegacyHandoffs(store, file, T0 + 200)).toBe(0);
    const runtime = new Runtime(store, idleRunner, { clock: { now: () => T0 + 300, monotonic: () => 0 } });
    runtime.open();
    expect(store.get("gen-1")).toMatchObject({ status: "waiting", restart: "cut" });
    expect(store.get("c-run")).toMatchObject({ status: "queued", restart: "rerun", restarts: 1 });
    store.close();
  });

  it("does nothing without a file", () => {
    const store = openRuntimeStore(":memory:");
    expect(importLegacyHandoffs(store, join(tmpdir(), "nope", "room-handoffs.json"), T0)).toBe(0);
    store.close();
  });
});

const NOW = T0 + 1_000;
const idle = { running: new Set<string>(), parked: new Set<string>() };

const queued = {
  "chief-chat": [
    { id: "task-1", sourceBotId: "chief", toBotId: "builder", message: "Build it", depth: 0, queuedAt: T0 + 10, approvalAlreadyGranted: true,
      origin: { kind: "user", request: "Ship it" }, waitAnnounced: true },
    { id: "task-2", sourceBotId: "chief", toBotId: "ops", message: "FYI: shipping tonight", depth: 0, queuedAt: T0 + 20, oneWay: true, targetThreadId: "ops-thread-7" },
  ],
  "bridge-thread": [
    { id: "task-3", sourceBotId: "bridge", toBotId: "tester", message: "Test it", depth: 0, queuedAt: T0 + 30, completionOwner: "external" },
  ],
};
const receipts = [
  { id: "rcpt-denied", sourceThreadId: "chief-chat", toBotId: "ops", toBotName: "Ops", status: "denied", approvalOutcome: "deny", approvalSource: "user",
    result: "Peer approval denied", finishedAt: T0 - 50 },
  { id: "rcpt-done", sourceThreadId: "old-thread", toBotId: "builder", toBotName: "Builder", status: "done", result: "Shipped", finishedAt: T0 - 100 },
  { id: "rcpt-cancelled", sourceThreadId: "old-thread", toBotId: "tester", toBotName: "Tester", status: "cancelled", finishedAt: T0 - 200 },
];

/** A data directory with the two ledger files; `null` leaves a file out. */
function ledgerDir(items: unknown = queued, list: unknown = receipts): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-ledger-"));
  if (items !== null) writeFileSync(join(dir, "delegations.json"), typeof items === "string" ? items : JSON.stringify(items));
  if (list !== null) writeFileSync(join(dir, "delegation-receipts.json"), typeof list === "string" ? list : JSON.stringify(list));
  return dir;
}

const threads: LegacyThreadResolver = {
  standingThreadOf: (botId) => ({ builder: "builder-standing", tester: "tester-standing" })[botId],
  botOfThread: (threadId) => ({ "old-thread": "old-bot" })[threadId],
};

describe("importLegacyDelegations", () => {
  it("brings queued items and receipts over once, ids kept, one root per source thread, and renames both files", () => {
    const dir = ledgerDir();
    const store = openRuntimeStore(":memory:");
    expect(importLegacyDelegations(store, dir, NOW)).toBe(9);
    expect(existsSync(join(dir, "delegations.json"))).toBe(false);
    expect(existsSync(join(dir, "delegations.json.migrated"))).toBe(true);
    expect(existsSync(join(dir, "delegation-receipts.json"))).toBe(false);
    expect(existsSync(join(dir, "delegation-receipts.json.migrated"))).toBe(true);

    const chiefRoot = store.get("legacy-chief-chat")!;
    expect(chiefRoot).toMatchObject({ status: "waiting", depth: 0, rootId: "legacy-chief-chat", mode: "work", reply: "resume", brief: "", executions: 1,
      origin: { kind: "person", source: "chat", ref: "chief-chat", quote: "Ship it" },
      requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat" },
      assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "chief-chat" } },
      budgets: { since: NOW, requests: 0, executions: 0, wakes: 0 }, createdAt: T0 + 10, lastActivityAt: NOW, level: "ask", levelSource: "own" });
    expect(store.events("legacy-chief-chat").map((e) => e.kind)).toEqual(["enqueued", "started", "waiting"]);
    expect(store.get("task-1")).toMatchObject({ status: "queued", depth: 1, parentId: "legacy-chief-chat", rootId: "legacy-chief-chat", brief: "Build it",
      mode: "work", reply: "resume", approved: true, executions: 0, createdAt: T0 + 10, lastActivityAt: NOW, level: "ask", levelSource: "own",
      origin: { kind: "person", quote: "Ship it" }, requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat" },
      assignee: { botId: "builder", destination: { kind: "standing_thread", threadId: "" } } });
    expect(store.get("task-1")!.requester.runId).toBeUndefined();
    expect(store.events("task-1").map((e) => e.kind)).toEqual(["enqueued"]);
    expect(store.get("task-2")).toMatchObject({ status: "queued", mode: "notify", reply: "none", brief: "FYI: shipping tonight", createdAt: T0 + 20,
      origin: { kind: "outside", source: "chat" }, assignee: { botId: "ops", destination: { kind: "work_thread", threadId: "ops-thread-7" } } });
    expect("approved" in store.get("task-2")!).toBe(false);
    expect(store.get("legacy-bridge-thread")).toMatchObject({ status: "waiting", reply: "poll",
      requester: { kind: "external_runtime", runId: "bridge-thread", botId: "bridge", threadId: "bridge-thread" },
      assignee: { botId: "bridge", destination: { kind: "standing_thread", threadId: "bridge-thread" } }, origin: { kind: "outside" } });
    expect(store.get("task-3")).toMatchObject({ status: "queued", mode: "work", reply: "poll", brief: "Test it",
      requester: { kind: "bot_turn", botId: "bridge", threadId: "bridge-thread", runId: "bridge-thread" } });

    expect(store.get("rcpt-denied")).toMatchObject({ status: "failed", outcome: "denied", outcomeDetail: "legacy receipt: denied", result: "Peer approval denied",
      parentId: "legacy-chief-chat", rootId: "legacy-chief-chat", depth: 1, executions: 0, finishedAt: T0 - 50, reportedAt: T0 - 50, createdAt: T0 - 50,
      brief: "", mode: "work", reply: "resume", requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat" },
      assignee: { botId: "ops", destination: { kind: "standing_thread", threadId: "" } } });
    expect("startedAt" in store.get("rcpt-denied")!).toBe(false);
    expect(store.events("rcpt-denied").map((e) => e.kind)).toEqual(["enqueued", "settled", "reported"]);
    const oldRoot = store.get("legacy-old-thread")!;
    expect(oldRoot).toMatchObject({ status: "completed", outcome: "done", depth: 0, createdAt: T0 - 200, finishedAt: T0 - 100, reportedAt: T0 - 100,
      requester: { kind: "bot_turn", botId: "unknown", threadId: "old-thread" }, assignee: { botId: "unknown", destination: { kind: "standing_thread", threadId: "old-thread" } } });
    expect(store.get("rcpt-done")).toMatchObject({ status: "completed", outcome: "done", result: "Shipped", executions: 1, startedAt: T0 - 100, finishedAt: T0 - 100,
      reportedAt: T0 - 100, parentId: "legacy-old-thread", requester: { kind: "bot_turn", botId: "unknown", threadId: "old-thread" } });
    expect("outcomeDetail" in store.get("rcpt-done")!).toBe(false);
    expect(store.events("rcpt-done").map((e) => e.kind)).toEqual(["enqueued", "started", "settled", "reported"]);
    expect(store.get("rcpt-cancelled")).toMatchObject({ status: "cancelled", outcome: "stopped", outcomeDetail: "legacy receipt: cancelled", result: "", executions: 0 });
    expect(store.events("rcpt-cancelled").map((e) => e.kind)).toEqual(["enqueued", "cancelled", "reported"]);
    expect(store.children("legacy-chief-chat").map((c) => c.id)).toEqual(["rcpt-denied", "task-1", "task-2"]);
    expect(checkInvariants(store, idle)).toEqual([]);

    expect(importLegacyDelegations(store, dir, NOW + 1)).toBe(0);
    expect(store.all()).toHaveLength(9);

    const runtime = new Runtime(store, idleRunner, { clock: { now: () => NOW + 2, monotonic: () => 0 } });
    runtime.open();
    runtime.tick();
    expect(store.get("legacy-chief-chat")).toMatchObject({ status: "waiting", executions: 1, restarts: 0 });
    expect(store.get("legacy-chief-chat")!.restart).toBeUndefined();
    expect(store.get("legacy-bridge-thread")).toMatchObject({ status: "waiting", restarts: 0 });
    for (const id of ["task-1", "task-2", "task-3"]) expect(store.get(id)).toMatchObject({ status: "queued", executions: 0, restarts: 0 });
    expect(store.all().filter((a) => a.restart !== undefined)).toEqual([]);
    expect(checkInvariants(store, idle)).toEqual([]);
    store.close();
  });

  it("leaves rows that already exist alone, so a crash between the writes and the rename is harmless", () => {
    const dir = ledgerDir();
    const store = openRuntimeStore(":memory:");
    expect(importLegacyDelegations(store, dir, NOW)).toBe(9);
    // The files come back, as after a crash before the rename.
    writeFileSync(join(dir, "delegations.json"), JSON.stringify(queued));
    writeFileSync(join(dir, "delegation-receipts.json"), JSON.stringify(receipts));
    const before = store.all();
    expect(importLegacyDelegations(store, dir, NOW + 5)).toBe(0);
    expect(store.all()).toEqual(before);
    expect(existsSync(join(dir, "delegations.json"))).toBe(false);
    store.close();
  });

  it("names threads through the host's resolver, and then runs the queue: the requester is resumed, the external runtime polls", async () => {
    const dir = ledgerDir();
    const store = openRuntimeStore(":memory:");
    const logs: string[] = [];
    expect(importLegacyDelegations(store, dir, NOW, { threads, log: (line) => logs.push(line) })).toBe(9);
    expect(logs).toEqual([]);
    expect(store.get("task-1")!.assignee.destination).toEqual({ kind: "standing_thread", threadId: "builder-standing" });
    expect(store.get("task-3")!.assignee.destination).toEqual({ kind: "standing_thread", threadId: "tester-standing" });
    expect(store.get("task-2")!.assignee.destination).toEqual({ kind: "work_thread", threadId: "ops-thread-7" });
    expect(store.get("legacy-old-thread")!.assignee.botId).toBe("old-bot");
    expect(store.get("rcpt-done")!.requester).toEqual({ kind: "bot_turn", botId: "old-bot", threadId: "old-thread" });

    const runs: Assignment[] = [];
    const reports: string[] = [];
    const runner: TurnRunner = {
      ...idleRunner, canStart: () => true,
      run: async (a) => { runs.push(a); return { kind: "completed", text: `${a.assignee.botId} done` }; },
      report: (a) => { reports.push(a.id); },
    };
    const runtime = new Runtime(store, runner, { clock: { now: () => NOW + 10, monotonic: () => 0 } });
    runtime.open();
    runtime.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runs.map((a) => a.id).sort()).toEqual(["task-1", "task-2", "task-3"]);
    expect(runs.find((a) => a.id === "task-1")).toMatchObject({ status: "running", executions: 1, level: "ask" });
    runtime.tick();
    expect(store.get("legacy-chief-chat")).toMatchObject({ status: "running", executions: 2 });
    const resume = runs.find((a) => a.id === "legacy-chief-chat");
    expect(resume).toBeDefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.get("legacy-chief-chat")).toMatchObject({ status: "completed", outcome: "done" });
    expect(store.get("legacy-bridge-thread")).toMatchObject({ status: "completed", outcome: "done", executions: 1 });
    expect(runtime.poll({ runId: "bridge-thread" }).items.map((i) => i.assignmentId)).toEqual(["task-3"]);
    expect(runtime.poll({ runId: "bridge-thread" }).items).toEqual([]);
    expect(store.inbox({ threadId: "chief-chat" }).map((i) => i.assignmentId)).toEqual(["task-1"]);
    expect(reports).toContain("task-2");
    expect(checkInvariants(store, idle)).toEqual([]);
    store.close();
  });

  it("a queue that awaits nothing (only one-way notices) leaves its root completed, as end() would", () => {
    const dir = ledgerDir({ "chief-chat": [queued["chief-chat"][1]] }, null);
    const store = openRuntimeStore(":memory:");
    expect(importLegacyDelegations(store, dir, NOW)).toBe(2);
    expect(store.get("legacy-chief-chat")).toMatchObject({ status: "completed", outcome: "done", finishedAt: NOW, reportedAt: NOW });
    expect(store.get("task-2")).toMatchObject({ status: "queued", mode: "notify", reply: "none" });
    expect(existsSync(join(dir, "delegations.json.migrated"))).toBe(true);
    expect(existsSync(join(dir, "delegation-receipts.json.migrated"))).toBe(false);
    expect(checkInvariants(store, idle)).toEqual([]);
    store.close();
  });

  it("does nothing without files, skips what it cannot read and says so, and still retires an unreadable file", () => {
    const store = openRuntimeStore(":memory:");
    expect(importLegacyDelegations(store, join(tmpdir(), "nope-ledger"), NOW)).toBe(0);
    const logs: string[] = [];
    const dir = ledgerDir({ "chief-chat": [{ toBotId: "builder" }, queued["chief-chat"][0]], "": [queued["chief-chat"][0]] }, "not json");
    expect(importLegacyDelegations(store, dir, NOW, { log: (line) => logs.push(line) })).toBe(2);
    expect(store.get("task-1")).toBeDefined();
    expect(logs.some((line) => /delegation-receipts\.json is not readable JSON/.test(line))).toBe(true);
    expect(logs.some((line) => /an item of chief-chat was skipped/.test(line))).toBe(true);
    expect(existsSync(join(dir, "delegations.json.migrated"))).toBe(true);
    expect(existsSync(join(dir, "delegation-receipts.json.migrated"))).toBe(true);
    expect(checkInvariants(store, idle)).toEqual([]);
    store.close();
  });
});
