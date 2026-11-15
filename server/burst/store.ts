// Durable bursts. Counts live on the burst row and every change to a child updates them in one transaction, so reading a
// burst's progress never scans its children, however large it is.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BurstChildRow, BurstChildStatus, BurstCounts, BurstPhase } from "../../shared/burst.ts";
import type { ModelSelection } from "../../shared/wire.ts";

export interface BurstRecord {
  id: string;
  botId: string;
  threadId: string;
  cardMessageId?: string;
  phase: BurstPhase;
  task: string;
  instructions: string;
  model: ModelSelection;
  modelName: string;
  /** Tasks the bot proposed, before the plan's task limit. */
  requested: number;
  /** The first few tasks, for the preview. */
  sample: string[];
  counts: BurstCounts;
  createdAt: number;
}

export interface BurstChild {
  burstId: string;
  seq: number;
  item: string;
  title: string;
  status: BurstChildStatus;
  threadId?: string;
  attempts: number;
  result?: string;
  error?: string;
}

const EMPTY: BurstCounts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bursts (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bursts_phase ON bursts(phase);
CREATE TABLE IF NOT EXISTS burst_children (
  burst_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (burst_id, seq)
);
CREATE INDEX IF NOT EXISTS burst_children_status ON burst_children(burst_id, status, seq);
`;

const titleOf = (item: string): string => {
  const line = item.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
};

export const sampleOf = (items: readonly string[]): string[] => items.slice(0, 5).map(titleOf);

export function openBurstStore(dataDir: string) {
  const file = dataDir === ":memory:" ? ":memory:" : join(dataDir, "bursts.db");
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const rows = {
    insertBurst: db.prepare("INSERT INTO bursts (id, json, phase, created_at) VALUES (?, ?, ?, ?)"),
    updateBurst: db.prepare("UPDATE bursts SET json = ?, phase = ? WHERE id = ?"),
    getBurst: db.prepare("SELECT json FROM bursts WHERE id = ?"),
    activeBursts: db.prepare("SELECT json FROM bursts WHERE phase IN ('running', 'merging') ORDER BY created_at"),
    deleteBurst: db.prepare("DELETE FROM bursts WHERE id = ?"),
    oldBursts: db.prepare("SELECT id FROM bursts WHERE phase IN ('done', 'cancelled') AND created_at < ?"),
    insertChild: db.prepare("INSERT INTO burst_children (burst_id, seq, json, status) VALUES (?, ?, ?, ?)"),
    updateChild: db.prepare("UPDATE burst_children SET json = ?, status = ? WHERE burst_id = ? AND seq = ?"),
    getChild: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? AND seq = ?"),
    nextQueued: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? AND status = 'queued' ORDER BY seq LIMIT 1"),
    childrenOf: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? ORDER BY seq"),
    childrenIn: db.prepare("SELECT json FROM burst_children WHERE burst_id = ? AND status = ? ORDER BY seq"),
    deleteChildren: db.prepare("DELETE FROM burst_children WHERE burst_id = ?"),
  };
  const parseBurst = (row: unknown): BurstRecord => JSON.parse((row as { json: string }).json) as BurstRecord;
  const parseChild = (row: unknown): BurstChild => JSON.parse((row as { json: string }).json) as BurstChild;
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const writeBurst = (burst: BurstRecord) => { rows.updateBurst.run(JSON.stringify(burst), burst.phase, burst.id); };
  const writeChild = (child: BurstChild) => { rows.updateChild.run(JSON.stringify(child), child.status, child.burstId, child.seq); };
  const insertChild = (id: string, seq: number, item: string) => {
    const child: BurstChild = { burstId: id, seq, item, title: titleOf(item), status: "queued", attempts: 0 };
    rows.insertChild.run(id, seq, JSON.stringify(child), "queued");
  };
  const getBurst = (id: string): BurstRecord | undefined => {
    const row = rows.getBurst.get(id);
    return row ? parseBurst(row) : undefined;
  };
  /** Moves a child to `status` and the counts with it, in one transaction. */
  const move = (burstId: string, seq: number, status: BurstChildStatus, change: (child: BurstChild) => void = () => {}): BurstChild | undefined =>
    transaction(() => {
      const row = rows.getChild.get(burstId, seq);
      const burst = getBurst(burstId);
      if (!row || !burst) return undefined;
      const child = parseChild(row);
      change(child);
      burst.counts[child.status] -= 1;
      burst.counts[status] += 1;
      child.status = status;
      writeChild(child);
      writeBurst(burst);
      return child;
    });
  /** Every child in `from` moves to `to`, counted once at the end. */
  const moveAll = (burstId: string, from: BurstChildStatus, to: BurstChildStatus, change: (child: BurstChild) => void = () => {}): BurstChild[] =>
    transaction(() => {
      const burst = getBurst(burstId);
      if (!burst) return [];
      const moved = rows.childrenIn.all(burstId, from).map(parseChild);
      for (const child of moved) {
        change(child);
        child.status = to;
        writeChild(child);
      }
      burst.counts[from] -= moved.length;
      burst.counts[to] += moved.length;
      writeBurst(burst);
      return moved;
    });
  return {
    create(input: Omit<BurstRecord, "counts" | "phase" | "sample"> & { items: readonly string[] }): BurstRecord {
      const { items, ...fields } = input;
      const burst: BurstRecord = { ...fields, phase: "preview", sample: sampleOf(items), counts: { ...EMPTY, queued: items.length } };
      transaction(() => {
        rows.insertBurst.run(burst.id, JSON.stringify(burst), burst.phase, burst.createdAt);
        items.forEach((item, seq) => insertChild(burst.id, seq, item));
      });
      return burst;
    },
    get: getBurst,
    child(burstId: string, seq: number): BurstChild | undefined {
      const row = rows.getChild.get(burstId, seq);
      return row ? parseChild(row) : undefined;
    },
    children(burstId: string): BurstChild[] {
      return rows.childrenOf.all(burstId).map(parseChild);
    },
    active(): BurstRecord[] {
      return rows.activeBursts.all().map(parseBurst);
    },
    update(id: string, patch: Partial<Pick<BurstRecord, "phase" | "cardMessageId">>): BurstRecord | undefined {
      return transaction(() => {
        const burst = getBurst(id);
        if (!burst) return undefined;
        Object.assign(burst, patch);
        writeBurst(burst);
        return burst;
      });
    },
    /** A preview's new list. */
    replacePlan(id: string, plan: { instructions?: string; items?: readonly string[]; requested?: number }): BurstRecord | undefined {
      return transaction(() => {
        const burst = getBurst(id);
        if (!burst) return undefined;
        if (plan.instructions !== undefined) burst.instructions = plan.instructions;
        if (plan.items) {
          rows.deleteChildren.run(id);
          plan.items.forEach((item, seq) => insertChild(id, seq, item));
          burst.counts = { ...EMPTY, queued: plan.items.length };
          burst.sample = sampleOf(plan.items);
          if (plan.requested !== undefined) burst.requested = plan.requested;
        }
        writeBurst(burst);
        return burst;
      });
    },
    /** The next queued child of this burst, now running: one indexed read. */
    takeQueued(burstId: string): BurstChild | undefined {
      const row = rows.nextQueued.get(burstId);
      return row ? move(burstId, parseChild(row).seq, "running", (child) => { child.attempts += 1; delete child.error; }) : undefined;
    },
    setThread(burstId: string, seq: number, threadId: string): void {
      transaction(() => {
        const row = rows.getChild.get(burstId, seq);
        if (!row) return;
        const child = parseChild(row);
        child.threadId = threadId;
        writeChild(child);
      });
    },
    /** A running child ended, unless a cancel settled it first. */
    settle(burstId: string, seq: number, status: "done" | "failed" | "cancelled", fields: { result?: string; error?: string }): BurstChild | undefined {
      const row = rows.getChild.get(burstId, seq);
      if (!row || parseChild(row).status !== "running") return undefined;
      return move(burstId, seq, status, (child) => {
        if (fields.result !== undefined) child.result = fields.result;
        if (fields.error !== undefined) child.error = fields.error;
      });
    },
    requeue(burstId: string, seq: number): BurstChild | undefined {
      return move(burstId, seq, "queued");
    },
    requeueRunning(burstId: string): BurstChild[] {
      return moveAll(burstId, "running", "queued");
    },
    /** Failed children go back in line, with their reason cleared. */
    requeueFailed(burstId: string): BurstChild[] {
      return moveAll(burstId, "failed", "queued", (child) => { delete child.error; delete child.result; });
    },
    cancelQueued(burstId: string): BurstChild[] {
      return moveAll(burstId, "queued", "cancelled");
    },
    childrenIn(burstId: string, status: BurstChildStatus): BurstChild[] {
      return rows.childrenIn.all(burstId, status).map(parseChild);
    },
    prune(before: number): number {
      const old = rows.oldBursts.all(before) as Array<{ id: string }>;
      transaction(() => { for (const { id } of old) { rows.deleteChildren.run(id); rows.deleteBurst.run(id); } });
      return old.length;
    },
    close(): void {
      db.close();
    },
  };
}

export type BurstStore = ReturnType<typeof openBurstStore>;

export const burstRow = (child: BurstChild): BurstChildRow => ({ seq: child.seq, title: child.title, status: child.status,
  ...(child.threadId ? { threadId: child.threadId } : {}), ...(child.error ? { error: child.error } : {}) });
