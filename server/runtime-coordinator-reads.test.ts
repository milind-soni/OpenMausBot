import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCoordinator, type Coordinator, type CoordinatorHost } from "./coordinator.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const host: CoordinatorHost = {
  validate: () => undefined, busy: () => true, run: async () => ({ ok: true, text: "" }), report() {}, changed() {}, park() {},
  names: () => ({ requester: "person", assignee: "bot", person: "person" }), levelOf: () => ({ level: "ask" }), chiefOf: () => false,
};

describe("the reads a finished turn makes", () => {
  let dir: string | undefined;
  let coordinator: Coordinator | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator?.close();
    if (dir) removeTempDir(dir);
    dir = coordinator = undefined;
  });

  function seeded(): Coordinator {
    dir = mkdtempSync(join(tmpdir(), "omb-coordinator-reads-"));
    let now = 1_000;
    coordinator = createCoordinator({ dataDir: dir, host, now: () => now, log: () => {} });
    for (let turn = 0; turn < 6; turn++) for (const bot of ["a", "b", "c"]) {
      now += 10;
      coordinator.beginTurn({ id: `${bot}-${turn}`, address: { botId: bot, threadId: `thread-${bot}` }, brief: "asked", level: "ask" });
      if (turn < 5) coordinator.endTurn(`${bot}-${turn}`, { ok: true, text: "done" });
    }
    coordinator.enqueue({ botId: "a", threadId: "thread-a" }, "a-5", undefined, { botId: "b", threadId: "thread-b" }, "Pull the numbers");
    return coordinator;
  }

  /** Every SELECT on assignments made while `read` runs, with how many rows each returned. */
  function watching<T>(read: () => T): { result: T; reads: Array<{ sql: string; rows: number }> } {
    const reads: Array<{ sql: string; rows: number }> = [];
    const all = StatementSync.prototype.all, get = StatementSync.prototype.get;
    const record = (statement: StatementSync, rows: number) => {
      if (/FROM assignments\b/.test(statement.sourceSQL)) reads.push({ sql: statement.sourceSQL, rows });
    };
    vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (this: StatementSync, ...args) {
      const rows = all.apply(this, args);
      record(this, rows.length);
      return rows;
    });
    vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (this: StatementSync, ...args) {
      const row = get.apply(this, args);
      record(this, row ? 1 : 0);
      return row;
    });
    try { return { result: read(), reads }; }
    finally { vi.restoreAllMocks(); }
  }

  it("finds a request's newest root by id, without reading the table", () => {
    const c = seeded();
    const { result, reads } = watching(() => c.newestRoot("thread-a", new Set(["a-1", "a-4", "b-4", "gone"])));
    expect(result?.id).toBe("a-4");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.sql).toMatch(/WHERE id = \?/);
      expect(read.rows).toBeLessThanOrEqual(1);
    }
    expect(c.newestRoot("thread-a", new Set(["b-4"]))).toBeUndefined();
    expect(c.newestRoot("thread-a", [])).toBeUndefined();
  });

  it("agrees with a read of every row", () => {
    const c = seeded();
    for (const [threadId, ids] of [["thread-a", ["a-0", "a-5", "c-5"]], ["thread-b", ["b-2"]], ["thread-c", ["a-1"]]] as const) {
      const wanted = new Set<string>(ids);
      const full = c.all().filter(node => !node.parentId && node.threadId === threadId && wanted.has(node.id)).sort((a, b) => a.createdAt - b.createdAt).at(-1);
      expect(c.newestRoot(threadId, wanted)).toEqual(full);
      expect(c.inThread(threadId)).toEqual(c.all().filter(node => node.threadId === threadId));
      expect(c.inThread(threadId, { open: true })).toEqual(c.all().filter(node => node.threadId === threadId && !["completed", "failed", "cancelled"].includes(node.status)));
    }
  });

  it("reads one thread's rows through the thread index", () => {
    const c = seeded();
    const open = watching(() => c.inThread("thread-b", { open: true }));
    expect(open.result.map(node => node.id).sort()).toEqual([open.result.find(node => node.parentId)!.id, "b-5"].sort());
    const since = watching(() => c.inThread("thread-b", { since: 0 }));
    expect(since.result).toHaveLength(7);
    const lists = [...open.reads, ...since.reads].filter(read => !/WHERE id = \?/.test(read.sql));
    expect(lists).toHaveLength(2);
    const db = new DatabaseSync(join(dir!, "runtime.db"), { readOnly: true });
    try {
      for (const read of lists) {
        expect(read.sql).toMatch(/WHERE .*assignee_thread_id = \?/);
        expect(read.rows).toBeLessThanOrEqual(7);
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...Array.from({ length: (read.sql.match(/\?/g) ?? []).length }, () => "x"))
          .map(step => String(step.detail)).join("; ");
        expect(plan).toMatch(/USING INDEX assignments_(assignee_thread|live)/);
        expect(plan).not.toMatch(/SCAN assignments(?! USING)/);
      }
    } finally { db.close(); }
  });

  it("no server code reads every assignment through the coordinator", () => {
    const root = new URL("./", import.meta.url);
    const offenders = (readdirSync(root, { recursive: true }) as string[])
      .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.split(/[\\/]/).includes("testing"))
      .filter(file => /\bcoordinator\.all\(\)/.test(readFileSync(new URL(file.replaceAll("\\", "/"), root), "utf8")));
    expect(offenders).toEqual([]);
  });
});
