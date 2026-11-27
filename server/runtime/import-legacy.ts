import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { RuntimeStore } from "./store.ts";
import { clip } from "./tree.ts";
import type { Assignment, Origin, Outcome, Requester, Status } from "./types.ts";

const BRIEF_MAX = 12_000;

const legacyNode = z.object({
  id: z.string(), rootId: z.string(), parentId: z.string().optional(),
  groupId: z.string().optional(), threadId: z.string(), botId: z.string(),
  text: z.string().default(""), createdAt: z.number(),
  requestBatchKey: z.string().optional(),
  status: z.enum(["source", "queued", "running", "waiting", "resume", "completed", "failed", "cancelled"]),
  result: z.string().default(""), reported: z.boolean().default(false),
  executions: z.number().int().nonnegative().default(0), startedAt: z.number().optional(),
  lastProgressAt: z.number().optional(),
  approvalGranted: z.boolean().default(false),
  origin: z.object({ kind: z.literal("user"), request: z.string() }).or(z.object({ kind: z.literal("outside") })).optional(),
  restarts: z.number().int().nonnegative().default(0),
  restart: z.enum(["rerun", "cut", "teammates"]).optional(),
}).passthrough();
type LegacyNode = z.infer<typeof legacyNode>;

const STATUS: Record<LegacyNode["status"], Status> = {
  source: "running", queued: "queued", running: "running", waiting: "waiting", resume: "resume",
  completed: "completed", failed: "failed", cancelled: "cancelled",
};

function origin(node: LegacyNode): Origin {
  if (node.origin?.kind === "user") return { kind: "person", source: "chat", ref: node.threadId, quote: node.origin.request };
  return { kind: "outside", source: "chat", ref: node.threadId };
}

/** Idempotent: existing rows are left alone, so a crash between the writes and the rename is harmless. */
export function importLegacyHandoffs(store: RuntimeStore, file: string, now: number): number {
  if (!existsSync(file)) return 0;
  const nodes = z.array(legacyNode).parse(JSON.parse(readFileSync(file, "utf8")));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: LegacyNode): number => {
    let d = 0;
    for (let cur = n; cur.parentId && byId.has(cur.parentId) && d < 64; cur = byId.get(cur.parentId)!) d += 1;
    return d;
  };
  const ordered = [...nodes].sort((a, b) => depth(a) - depth(b) || a.createdAt - b.createdAt);
  let written = 0;
  store.transaction(() => {
    for (const n of ordered) {
      if (store.get(n.id)) continue;
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      const root = byId.get(n.rootId) ?? n;
      const status = STATUS[n.status];
      const terminal = status === "completed" || status === "failed" || status === "cancelled";
      const row: Assignment = {
        id: n.id, rootId: n.rootId, depth: depth(n),
        origin: origin(root),
        requester: parent
          ? { kind: "bot_turn", botId: parent.botId, threadId: parent.threadId }
          : { kind: "person", threadId: n.threadId, botId: n.botId },
        assignee: { botId: n.botId, destination: {
          kind: n.groupId ? "room_thread" : parent ? "work_thread" : "standing_thread", threadId: n.threadId,
          ...(n.groupId ? { groupId: n.groupId } : {}) } },
        mode: "work", reply: "resume", brief: n.text.slice(0, 12_000), status,
        level: "ask", levelSource: "own",
        executions: n.status === "source" ? Math.max(1, n.executions) : n.executions, restarts: n.restarts,
        createdAt: n.createdAt, lastActivityAt: n.lastProgressAt ?? n.startedAt ?? n.createdAt,
        result: n.result.slice(0, 12_000), rework: false, version: 1,
        ...(n.parentId ? { parentId: n.parentId } : {}),
        ...(n.startedAt !== undefined ? { startedAt: n.startedAt } : {}),
        ...(n.restart ? { restart: n.restart } : {}),
        ...(n.approvalGranted ? { approved: true } : {}),
        ...(n.requestBatchKey ? { batchKey: n.requestBatchKey } : {}),
        ...(terminal ? { finishedAt: n.lastProgressAt ?? now, outcome: status === "completed" ? "done" : status === "failed" ? "provider_error" : "stopped",
          ...(n.reported ? { reportedAt: n.lastProgressAt ?? now } : {}) } : {}),
        ...(!parent ? { budgets: { since: now, requests: 0, executions: 0, wakes: 0 } } : {}),
      } as Assignment;
      store.insert(row, { kind: "enqueued", at: now, detail: `imported from room-handoffs.json as ${n.status}` });
      if (status === "running" || status === "waiting" || status === "resume") {
        store.update(row, { kind: "started", at: now, detail: `running: imported turn ${row.executions}, level ${row.level}` });
      }
      if (terminal) store.update(row, { kind: status === "cancelled" ? "cancelled" : "settled", at: now, detail: `${status}: imported` });
      written += 1;
    }
  });
  renameSync(file, `${file}.migrated`);
  return written;
}

export interface LegacyThreadResolver {
  standingThreadOf(botId: string): string | undefined;
  botOfThread(threadId: string): string | undefined;
}

export interface LegacyLedgerOptions {
  threads?: LegacyThreadResolver;
  log?: (line: string) => void;
}

const legacyWorkOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), request: z.string().min(1) }),
  z.object({ kind: z.literal("outside") }),
]);

const legacyItem = z.object({
  id: z.string().min(1),
  sourceBotId: z.string().default(""),
  toBotId: z.string().min(1),
  message: z.string(),
  approvalAlreadyGranted: z.boolean().optional(),
  targetThreadId: z.string().optional(),
  oneWay: z.boolean().optional(),
  completionOwner: z.literal("external").optional(),
  origin: legacyWorkOrigin.optional(),
  queuedAt: z.number().optional(),
}).passthrough();
type LegacyItem = z.infer<typeof legacyItem>;

const legacyReceipt = z.object({
  id: z.string().min(1),
  sourceThreadId: z.string().min(1),
  toBotId: z.string().min(1),
  status: z.string(),
  result: z.string().optional(),
  finishedAt: z.number(),
}).passthrough();
type LegacyReceipt = z.infer<typeof legacyReceipt>;

const RAN: ReadonlySet<string> = new Set(["done", "failed", "error"]);

const UNKNOWN_BOT = "unknown";

const legacyRootId = (sourceThreadId: string): string => `legacy-${sourceThreadId}`;

function ledgerOrigin(origin: LegacyItem["origin"], threadId: string): Origin {
  if (origin?.kind === "user") return { kind: "person", source: "chat", ref: threadId, quote: origin.request };
  return { kind: "outside", source: "chat", ref: threadId };
}

function receiptEnd(status: string): { status: Status; outcome: Outcome } {
  switch (status) {
    case "done": return { status: "completed", outcome: "done" };
    case "denied": return { status: "failed", outcome: "denied" };
    case "expired": return { status: "failed", outcome: "expired" };
    case "cancelled": return { status: "cancelled", outcome: "stopped" };
    default: return { status: "failed", outcome: "provider_error" };
  }
}

function readJson(file: string, log: (line: string) => void): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    log(`${file} is not readable JSON and was not imported: ${String(error)}`);
    return null;
  }
}

/** Idempotent: existing rows are left alone, so a crash between the writes and the rename is harmless. */
export function importLegacyDelegations(store: RuntimeStore, dataDir: string, now: number, options: LegacyLedgerOptions = {}): number {
  const log = options.log ?? (() => {});
  const threads = options.threads;
  const itemsFile = join(dataDir, "delegations.json");
  const receiptsFile = join(dataDir, "delegation-receipts.json");
  const rawItems = readJson(itemsFile, log);
  const rawReceipts = readJson(receiptsFile, log);
  if (rawItems === undefined && rawReceipts === undefined) return 0;

  const queues = new Map<string, LegacyItem[]>();
  if (rawItems && typeof rawItems === "object" && !Array.isArray(rawItems)) {
    for (const [threadId, list] of Object.entries(rawItems as Record<string, unknown>)) {
      if (!threadId || !Array.isArray(list)) continue;
      const items = list.flatMap((value) => {
        const parsed = legacyItem.safeParse(value);
        if (!parsed.success) log(`delegations.json: an item of ${threadId} was skipped: ${parsed.error.message}`);
        return parsed.success ? [parsed.data] : [];
      });
      if (items.length) queues.set(threadId, items);
    }
  }
  const receipts: LegacyReceipt[] = Array.isArray(rawReceipts)
    ? rawReceipts.flatMap((value) => {
      const parsed = legacyReceipt.safeParse(value);
      if (!parsed.success) log(`delegation-receipts.json: a receipt was skipped: ${parsed.error.message}`);
      return parsed.success ? [parsed.data] : [];
    })
    : [];

  const botOf = (threadId: string, recorded?: string): string => recorded || threads?.botOfThread(threadId) || UNKNOWN_BOT;
  let written = 0;
  store.transaction(() => {
    for (const [threadId, items] of queues) {
      const rootId = legacyRootId(threadId);
      const sourceBotId = botOf(threadId, items.find((item) => item.sourceBotId)?.sourceBotId);
      const external = items.some((item) => item.completionOwner === "external");
      const awaited = items.some((item) => !item.oneWay);
      const first = items[0]!;
      const createdAt = Math.min(now, ...items.map((item) => item.queuedAt ?? now));
      if (!store.get(rootId)) {
        const requester: Requester = external
          ? { kind: "external_runtime", runId: threadId, botId: sourceBotId, threadId }
          : { kind: "bot_turn", botId: sourceBotId, threadId };
        const root: Assignment = {
          id: rootId, rootId, depth: 0, origin: ledgerOrigin(first.origin, threadId), requester,
          assignee: { botId: sourceBotId, destination: { kind: "standing_thread", threadId } },
          mode: "work", reply: external ? "poll" : "resume", brief: "", status: awaited ? "waiting" : "completed",
          level: "ask", levelSource: "own", executions: 1, restarts: 0, createdAt, startedAt: createdAt, lastActivityAt: now,
          result: "", rework: false, budgets: { since: now, requests: 0, executions: 0, wakes: 0 }, version: 1,
          ...(awaited ? {} : { outcome: "done" as const, finishedAt: now, reportedAt: now }),
        };
        store.insert(root, { kind: "enqueued", at: now, detail: "queued: root, imported from delegations.json" });
        store.update(root, { kind: "started", at: now, detail: `running: turn 1 (host), level ${root.level}` });
        if (awaited) store.update(root, { kind: "waiting", at: now, detail: "waiting: imported queue" });
        else {
          store.update(root, { kind: "settled", at: now, detail: "completed: done — imported queue awaits nothing" });
          store.update(root, { kind: "reported", at: now, detail: "own turn" });
        }
        written += 1;
      }
      for (const item of items) {
        if (store.get(item.id)) continue;
        const notify = item.oneWay === true;
        const poll = item.completionOwner === "external";
        const requester: Requester = { kind: "bot_turn", botId: sourceBotId, threadId, ...(poll ? { runId: threadId } : {}) };
        const targetThreadId = item.targetThreadId || threads?.standingThreadOf(item.toBotId) || "";
        const child: Assignment = {
          id: item.id, rootId, parentId: rootId, depth: 1, origin: ledgerOrigin(item.origin, threadId), requester,
          assignee: { botId: item.toBotId, destination: { kind: item.targetThreadId ? "work_thread" : "standing_thread", threadId: targetThreadId } },
          mode: notify ? "notify" : "work", reply: notify ? "none" : poll ? "poll" : "resume", brief: clip(item.message, BRIEF_MAX),
          status: "queued", level: "ask", levelSource: "own", executions: 0, restarts: 0,
          createdAt: item.queuedAt ?? now, lastActivityAt: now, result: "", rework: false, version: 1,
          ...(item.approvalAlreadyGranted ? { approved: true } : {}),
        };
        store.insert(child, { kind: "enqueued", at: now, detail: `queued: imported from delegations.json${notify ? " (one-way)" : poll ? " (external)" : ""}` });
        written += 1;
      }
    }
    for (const receipt of receipts) {
      if (store.get(receipt.id)) continue;
      const rootId = legacyRootId(receipt.sourceThreadId);
      let root = store.get(rootId);
      if (!root) {
        const sourceBotId = botOf(receipt.sourceThreadId);
        const ended = receipts.filter((r) => r.sourceThreadId === receipt.sourceThreadId).map((r) => r.finishedAt);
        const createdAt = Math.min(now, ...ended);
        const finishedAt = Math.min(now, Math.max(...ended));
        root = {
          id: rootId, rootId, depth: 0, origin: { kind: "outside", source: "chat", ref: receipt.sourceThreadId },
          requester: { kind: "bot_turn", botId: sourceBotId, threadId: receipt.sourceThreadId },
          assignee: { botId: sourceBotId, destination: { kind: "standing_thread", threadId: receipt.sourceThreadId } },
          mode: "work", reply: "resume", brief: "", status: "completed", outcome: "done", level: "ask", levelSource: "own",
          executions: 1, restarts: 0, createdAt, startedAt: createdAt, lastActivityAt: finishedAt, finishedAt, reportedAt: finishedAt,
          result: "", rework: false, budgets: { since: now, requests: 0, executions: 0, wakes: 0 }, version: 1,
        };
        store.insert(root, { kind: "enqueued", at: now, detail: "queued: root, imported from delegation-receipts.json" });
        store.update(root, { kind: "started", at: now, detail: `running: turn 1 (host), level ${root.level}` });
        store.update(root, { kind: "settled", at: now, detail: "completed: done — imported receipts" });
        store.update(root, { kind: "reported", at: now, detail: "own turn" });
        written += 1;
      }
      const end = receiptEnd(receipt.status);
      const ran = RAN.has(receipt.status);
      const row: Assignment = {
        id: receipt.id, rootId, parentId: rootId, depth: 1, origin: root.origin,
        requester: { kind: "bot_turn", botId: root.assignee.botId, threadId: receipt.sourceThreadId },
        assignee: { botId: receipt.toBotId, destination: { kind: "standing_thread", threadId: "" } },
        mode: "work", reply: "resume", brief: "", status: end.status, outcome: end.outcome,
        ...(receipt.status === "done" ? {} : { outcomeDetail: `legacy receipt: ${receipt.status}` }),
        level: "ask", levelSource: "own", executions: ran ? 1 : 0, restarts: 0,
        createdAt: receipt.finishedAt, ...(ran ? { startedAt: receipt.finishedAt } : {}), lastActivityAt: receipt.finishedAt,
        finishedAt: receipt.finishedAt, reportedAt: receipt.finishedAt, result: clip(receipt.result ?? "", BRIEF_MAX), rework: false, version: 1,
      };
      store.insert(row, { kind: "enqueued", at: now, detail: "queued: imported from delegation-receipts.json" });
      if (ran) store.update(row, { kind: "started", at: now, detail: `running: imported turn 1, level ${row.level}` });
      store.update(row, { kind: end.status === "cancelled" ? "cancelled" : "settled", at: now, detail: `${end.status}: ${end.outcome} — imported receipt ${receipt.status}` });
      store.update(row, { kind: "reported", at: now, detail: "reported: imported receipt" });
      written += 1;
    }
  });
  if (rawItems !== undefined) renameSync(itemsFile, `${itemsFile}.migrated`);
  if (rawReceipts !== undefined) renameSync(receiptsFile, `${receiptsFile}.migrated`);
  return written;
}
