import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import type { TurnLane } from "./turn-scheduler.ts";

export type WorkOrderKind = "consultation" | "delegation";
export type WorkOrderState = "pending-source" | "awaiting-approval" | "queued" | "running" | "completed" | "failed" | "cancelled";
export type WorkOrderDelivery = "inline" | "channel" | "continuation";

export interface WorkOrderInput {
  kind: WorkOrderKind;
  sourceBotId: string;
  sourceTaskId: string;
  sourceExecutionId?: string;
  targetBotId: string;
  targetTaskId: string;
  request: string;
  reason?: string;
  priority?: Exclude<TurnLane, "user">;
  depth: number;
  delivery: WorkOrderDelivery;
  channelId?: string;
  attempt?: number;
}

export interface WorkOrder extends WorkOrderInput {
  id: string;
  state: WorkOrderState;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
}

export const WORK_ORDER_REQUEST_MAX_LENGTH = 20_000;
export const WORK_ORDER_REASON_MAX_LENGTH = 2_000;

export class WorkOrderCapacityError extends Error {
  readonly code = "WORK_ORDER_CAPACITY";

  constructor(limit: number) {
    super(`work-order capacity reached (${limit} active orders)`);
    this.name = "WorkOrderCapacityError";
  }
}

export class WorkOrderInputError extends Error {
  readonly code = "WORK_ORDER_INPUT_TOO_LARGE";

  constructor(field: "request" | "reason", limit: number) {
    super(`${field} exceeds the ${limit}-character work-order limit`);
    this.name = "WorkOrderInputError";
  }
}

interface DiskFile {
  version: 1;
  orders: WorkOrder[];
}

const TERMINAL: ReadonlySet<WorkOrderState> = new Set(["completed", "failed", "cancelled"]);
const TRANSITIONS: Record<WorkOrderState, readonly WorkOrderState[]> = {
  "pending-source": ["awaiting-approval", "queued", "cancelled", "failed"],
  "awaiting-approval": ["queued", "cancelled", "failed"],
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Crash-safe peer work orders. This is intentionally separate from the
 * provider and transcript stores: an accepted handoff must survive a bot
 * restart without becoming a fake assistant message or a hidden turn.
 */
export class WorkOrderStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxTerminal: number;
  private readonly maxActive: number;
  private readonly onTransition?: (order: WorkOrder, from: WorkOrderState, to: WorkOrderState) => void;
  private orders: WorkOrder[] = [];

  constructor(options: {
    file?: string;
    now?: () => number;
    maxTerminal?: number;
    maxActive?: number;
    onTransition?: (order: WorkOrder, from: WorkOrderState, to: WorkOrderState) => void;
  } = {}) {
    this.file = options.file ?? join(DATA_DIR, "work-orders.json");
    this.now = options.now ?? Date.now;
    this.maxTerminal = Math.max(1, Math.trunc(options.maxTerminal ?? 200));
    this.maxActive = Math.max(1, Math.trunc(options.maxActive ?? 256));
    this.onTransition = options.onTransition;
    this.load();
  }

  create(input: WorkOrderInput, state: WorkOrderState = "pending-source"): WorkOrder {
    if (state !== "pending-source" && state !== "awaiting-approval" && state !== "queued") {
      throw new Error("new work orders must begin pending-source, awaiting-approval, or queued");
    }
    if (input.request.length > WORK_ORDER_REQUEST_MAX_LENGTH) {
      throw new WorkOrderInputError("request", WORK_ORDER_REQUEST_MAX_LENGTH);
    }
    if (input.reason && input.reason.length > WORK_ORDER_REASON_MAX_LENGTH) {
      throw new WorkOrderInputError("reason", WORK_ORDER_REASON_MAX_LENGTH);
    }
    if (this.orders.filter((order) => !TERMINAL.has(order.state)).length >= this.maxActive) {
      throw new WorkOrderCapacityError(this.maxActive);
    }
    const at = this.now();
    const order: WorkOrder = {
      ...input,
      id: newId(),
      state,
      request: input.request,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      attempt: Math.max(0, Math.trunc(input.attempt ?? 0)),
      createdAt: at,
      updatedAt: at,
    };
    this.orders.push(order);
    this.save();
    this.onTransition?.({ ...order }, state, state);
    return { ...order };
  }

  get(id: string): WorkOrder | null {
    const order = this.orders.find((candidate) => candidate.id === id);
    return order ? { ...order } : null;
  }

  list(options: { sourceBotId?: string; targetBotId?: string; states?: WorkOrderState[]; limit?: number } = {}): WorkOrder[] {
    const states = options.states ? new Set(options.states) : null;
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    return this.orders
      .filter((order) =>
        (!options.sourceBotId || order.sourceBotId === options.sourceBotId) &&
        (!options.targetBotId || order.targetBotId === options.targetBotId) &&
        (!states || states.has(order.state)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((order) => ({ ...order }));
  }

  transition(id: string, to: WorkOrderState, patch: Partial<Pick<WorkOrder, "result" | "error" | "attempt" | "channelId">> = {}): WorkOrder {
    const order = this.orders.find((candidate) => candidate.id === id);
    if (!order) throw new Error("no such work order");
    const from = order.state;
    if (from === to) return { ...order };
    if (TERMINAL.has(from)) throw new Error("terminal work orders are immutable");
    if (!TRANSITIONS[from].includes(to)) throw new Error(`invalid work-order transition ${from} → ${to}`);
    order.state = to;
    order.updatedAt = this.now();
    if (patch.attempt !== undefined) order.attempt = Math.max(0, Math.trunc(patch.attempt));
    if (patch.channelId !== undefined) order.channelId = patch.channelId;
    // Requests are intentionally never passed through redaction. Results and
    // failures may contain tool output, credentials, or provider diagnostics.
    if (patch.result !== undefined) order.result = redactSecretsInText(patch.result).slice(0, 20_000);
    if (patch.error !== undefined) order.error = redactSecretsInText(patch.error).slice(0, 2_000);
    this.save();
    this.onTransition?.({ ...order }, from, to);
    return { ...order };
  }

  cancel(id: string, reason = "cancelled by user"): WorkOrder | null {
    const order = this.orders.find((candidate) => candidate.id === id);
    if (!order || TERMINAL.has(order.state)) return null;
    return this.transition(id, "cancelled", { error: reason });
  }

  /** Settle every active order pinned to a bot that is being deleted. */
  settleForDeletedBot(botId: string): { cancelled: WorkOrder[]; failed: WorkOrder[] } {
    const cancelled: WorkOrder[] = [];
    const failed: WorkOrder[] = [];
    for (const order of [...this.orders]) {
      if (TERMINAL.has(order.state)) continue;
      if (order.sourceBotId === botId) {
        cancelled.push(this.transition(order.id, "cancelled", { error: "source bot was deleted" }));
      } else if (order.targetBotId === botId) {
        failed.push(this.transition(order.id, "failed", { error: "target bot was deleted" }));
      }
    }
    return { cancelled, failed };
  }

  /** Pending/approval work may be reconstructed; source and running work cannot. */
  recover(): { cancelled: WorkOrder[]; failed: WorkOrder[] } {
    const cancelled: WorkOrder[] = [];
    const failed: WorkOrder[] = [];
    for (const order of this.orders) {
      if (order.state === "pending-source") {
        cancelled.push(this.transition(order.id, "cancelled", { error: "source execution did not survive restart" }));
      } else if (order.state === "running") {
        failed.push(this.transition(order.id, "failed", { error: "OpenMausBot restarted while this work was running" }));
      }
    }
    return { cancelled, failed };
  }

  private load(): void {
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DiskFile>;
      if (!Array.isArray(disk.orders)) return;
      this.orders = disk.orders.flatMap((value) => this.validOrder(value));
    } catch {
      this.orders = [];
    }
    // A fresh process cannot answer old approval promises, but the queued
    // and approval-waiting records remain visible for the boot reconciler.
    this.pruneTerminal();
  }

  private validOrder(value: unknown): WorkOrder[] {
    if (!value || typeof value !== "object") return [];
    const item = value as Partial<WorkOrder>;
    if (
      typeof item.id !== "string" || typeof item.kind !== "string" ||
      typeof item.sourceBotId !== "string" || typeof item.sourceTaskId !== "string" ||
      typeof item.targetBotId !== "string" || typeof item.targetTaskId !== "string" ||
      typeof item.request !== "string" || typeof item.depth !== "number" ||
      typeof item.createdAt !== "number" || typeof item.updatedAt !== "number" ||
      !item.state || !TRANSITIONS[item.state as WorkOrderState]
    ) return [];
    return [{
      ...(item as WorkOrder),
      request: item.request,
      ...(typeof item.result === "string" ? { result: redactSecretsInText(item.result) } : {}),
      ...(typeof item.error === "string" ? { error: redactSecretsInText(item.error) } : {}),
    }];
  }

  private pruneTerminal(): void {
    const terminal = this.orders.filter((order) => TERMINAL.has(order.state));
    if (terminal.length <= this.maxTerminal) return;
    const keep = new Set(terminal.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, this.maxTerminal).map((order) => order.id));
    this.orders = this.orders.filter((order) => !TERMINAL.has(order.state) || keep.has(order.id));
  }

  private save(): void {
    this.pruneTerminal();
    writeFileAtomic(this.file, JSON.stringify({ version: 1, orders: this.orders }, null, 2), { mode: 0o600 });
  }
}
