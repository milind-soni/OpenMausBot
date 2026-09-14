import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const nodeSchema = z.object({
  id: z.string(), rootId: z.string(), parentId: z.string().optional(),
  groupId: z.string().optional(), threadId: z.string(), botId: z.string(),
  key: z.string(), text: z.string(), createdAt: z.number(),
  status: z.enum(["source", "queued", "running", "waiting", "resume", "completed", "failed", "cancelled"]),
  result: z.string().default(""), reported: z.boolean().default(false),
  executions: z.number().int().nonnegative().default(0), startedAt: z.number().optional(),
  approvalGranted: z.boolean().default(false),
  kind: z.enum(["work", "assignment"]).default("work"),
});
export type RoomHandoff = z.infer<typeof nodeSchema>;
export type RoomAddress = Pick<RoomHandoff, "groupId" | "threadId" | "botId">;
export const ROOM_HANDOFF_LIMITS = { depth: 4, requests: 24, executions: 48, lifetimeMs: 30 * 60_000, minRunwayMs: 10 * 60_000 };
/** Renders elapsed milliseconds as whole minutes, or seconds under one minute. */
const duration = (ms: number) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;
const terminal = (n: RoomHandoff) => ["completed", "failed", "cancelled"].includes(n.status);

export interface RoomHandoffHooks {
  /** Recheck addresses and route permission immediately before every dispatch. */
  validate(node: RoomHandoff, parent?: RoomHandoff): string | undefined;
  busy(node: RoomHandoff): boolean;
  run(node: RoomHandoff, resumed: boolean, signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
  report(child: RoomHandoff, parent: RoomHandoff): void;
  changed(groupIds: ReadonlySet<string>, directThreadIds: ReadonlySet<string>): void;
}

/** A bounded tree of addressed room turns. Waiting for children never holds a
 * room/provider queue; reporting is data, and only the named parent is resumed.
 * Interrupted processes are never replayed after restart (tools may have effects).
 */
export class RoomHandoffs {
  readonly nodes = new Map<string, RoomHandoff>();
  private readonly controllers = new Map<string, AbortController>();
  private loadError?: string;
  private readonly file: string;
  private readonly hooks: RoomHandoffHooks;
  private readonly now: () => number;

  constructor(file: string, hooks: RoomHandoffHooks, now: () => number = Date.now) {
    this.file = file; this.hooks = hooks; this.now = now;
    try {
      const saved = z.array(nodeSchema).max(10_000).parse(JSON.parse(readFileSync(file, "utf8")));
      const ids = new Map(saved.map(n => [n.id, n]));
      if (ids.size !== saved.length || saved.some(n => !ids.has(n.rootId) || ids.get(n.rootId)?.parentId ||
        (n.parentId && (!ids.has(n.parentId) || ids.get(n.parentId)?.rootId !== n.rootId)))) throw new Error("Invalid room handoff tree");
      for (const n of saved) {
        if (!terminal(n)) { n.status = "failed"; n.result = "Interrupted by server restart; not replayed."; }
        this.nodes.set(n.id, n);
      }
      this.save();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.loadError = "Room handoff storage is unreadable; repair it before sending new work.";
    }
  }

  private save() { writeFileAtomic(this.file, JSON.stringify([...this.nodes.values()]), { mode: 0o600 }); }
  private publish(...nodes: RoomHandoff[]) {
    this.save();
    this.hooks.changed(new Set(nodes.flatMap(node => node.groupId ? [node.groupId] : [])),
      new Set(nodes.filter(node => !node.groupId).map(node => node.threadId)));
  }
  children(id: string) { return [...this.nodes.values()].filter(n => n.parentId === id); }
  root(n: RoomHandoff) { return this.nodes.get(n.rootId)!; }
  path(n: RoomHandoff): RoomHandoff[] {
    const path: RoomHandoff[] = [];
    for (let cur: RoomHandoff | undefined = n; cur; cur = cur.parentId ? this.nodes.get(cur.parentId) : undefined) {
      if (path.some(p => p.id === cur!.id)) throw new Error("Invalid handoff ancestry");
      path.unshift(cur);
    }
    return path;
  }

  /** The earliest moment this node may be failed for lifetime: the tree
   * ceiling or, for a running node, its own start plus a minimum runway. */
  private deadline(n: RoomHandoff): number {
    const anchor = n.status === "running" ? n.startedAt ?? n.createdAt : n.createdAt;
    return Math.max(this.root(n).createdAt + ROOM_HANDOFF_LIMITS.lifetimeMs, anchor + ROOM_HANDOFF_LIMITS.minRunwayMs);
  }
  /** An ancestor past its ceiling is not failed while a descendant is still
   * running inside its own runway; cancelling would cascade into that work. */
  private protectsRunner(n: RoomHandoff): boolean {
    return this.children(n.id).some(c => !terminal(c) && ((c.status === "running" && this.now() <= this.deadline(c)) || this.protectsRunner(c)));
  }
  /** A parent still owes the follow-up execution that decides on its
   * children's results; the ceiling defers to that execution's own runway. */
  private owesFollowUp(n: RoomHandoff): boolean {
    if (n.status === "resume") return true;
    if (n.status !== "waiting") return false;
    const children = this.children(n.id);
    return (children.length > 0 && children.every(c => terminal(c))) || children.some(c => this.owesFollowUp(c));
  }
  /** Names the budget, the node's status, and the elapsed tree time. */
  private lifetimeError(n: RoomHandoff): string {
    return `Room handoff lifetime budget exhausted: node was ${n.status} after ${duration(this.now() - this.root(n).createdAt)} of the ${duration(ROOM_HANDOFF_LIMITS.lifetimeMs)} tree lifetime`;
  }

  enqueue(source: RoomAddress, generation: string, parentId: string | undefined,
    target: RoomAddress, key: string, text: string, approvalGranted = false,
    rework = false, sourceText = ""): { node: RoomHandoff; duplicate: boolean } {
    if (this.loadError) throw new Error(this.loadError);
    let parent = parentId ? this.nodes.get(parentId) : this.nodes.get(generation);
    if (parentId && (!parent || parent.status !== "running")) throw new Error("The originating room task is no longer running");
    if (parent && (parent.groupId !== source.groupId || parent.threadId !== source.threadId || parent.botId !== source.botId)) {
      throw new Error("The handoff belongs to a different room speaker");
    }
    const fresh = !parent;
    parent ??= { ...source, id: generation, rootId: generation, key: "root", text: sourceText.slice(0, 12_000), createdAt: this.now(), status: "source", result: "", reported: true, executions: 0, approvalGranted: false, kind: "work" };
    const kind = target.groupId && target.groupId === source.groupId ? "assignment" : "work";
    const path = this.path(parent);
    if (path.some(n => n.botId === target.botId && (!n.groupId || !target.groupId || n.groupId === target.groupId))) {
      throw new Error("Cannot assign work back to an ancestor; results return automatically");
    }
    const existing = this.children(parent.id).find(n => n.key === key);
    if (existing) {
      if (existing.groupId !== target.groupId || existing.botId !== target.botId || existing.text !== text ||
        existing.kind !== kind) throw new Error("request_key was already used for different work");
      return { node: existing, duplicate: true };
    }
    if (!rework && this.children(parent.id).some(n => n.kind === kind &&
      n.groupId === target.groupId && n.botId === target.botId && n.status === "completed")) {
      throw new Error("This agent already completed your assignment. Do not send acknowledgements or approvals as new work. Finish with your decision; results return automatically. Only use rework=true for concrete additional work.");
    }
    if (kind === "work" && target.groupId && path.some(n => n.groupId === target.groupId)) throw new Error("A room request cannot return to an ancestor room; results are returned automatically");
    // The path includes the source root, so its work-node count is the
    // proposed edge depth: four edges are allowed; the fifth is refused.
    if (kind === "work" && path.filter(n => n.kind === "work").length > ROOM_HANDOFF_LIMITS.depth) throw new Error("Room handoff depth limit reached");
    const root = fresh ? parent : this.root(parent);
    const count = [...this.nodes.values()].filter(n => n.rootId === parent!.rootId && n.parentId).length;
    if (count >= ROOM_HANDOFF_LIMITS.requests) throw new Error("Room handoff budget exhausted");
    // Refuse work the tree's lifetime budget cannot honestly serve: a node
    // accepted in the root's last minutes would be doomed at enqueue time.
    const remaining = ROOM_HANDOFF_LIMITS.lifetimeMs - (this.now() - root.createdAt);
    if (remaining < ROOM_HANDOFF_LIMITS.minRunwayMs) {
      throw new Error(`Room handoff budget exhausted: only ${duration(Math.max(remaining, 0))} of the ${duration(ROOM_HANDOFF_LIMITS.lifetimeMs)} tree lifetime remains`);
    }
    // Retain a bounded audit history without evicting active requests.
    if (this.nodes.size >= 1000) {
      const oldRoots = [...this.nodes.values()].filter(n => !n.parentId && terminal(n)).sort((a, b) => a.createdAt - b.createdAt);
      for (const old of oldRoots) {
        if (this.nodes.size < 800) break;
        for (const n of this.nodes.values()) if (n.rootId === old.id) this.nodes.delete(n.id);
      }
      if (this.nodes.size >= 1000) throw new Error("Too many active room requests");
    }
    const node: RoomHandoff = { ...target, id: randomUUID(), rootId: parent.rootId, parentId: parent.id,
      key, text, createdAt: this.now(), status: "queued", result: "", reported: false, executions: 0, approvalGranted,
      kind };
    const problem = this.hooks.validate(node, parent);
    if (problem) throw new Error(problem);
    if (fresh) this.nodes.set(parent.id, parent);
    this.nodes.set(node.id, node);
    try { this.publish(node, parent); } catch (e) { this.nodes.delete(node.id); if (fresh) this.nodes.delete(parent.id); throw e; }
    return { node, duplicate: false };
  }

  sourceSettled(generation: string, ok: boolean) {
    const node = this.nodes.get(generation);
    if (!node || node.status !== "source") return;
    if (!ok) this.cancelTree(node, "The originating room turn did not finish", "failed");
    else { node.status = "waiting"; this.publish(node); }
  }

  cancelTree(node: RoomHandoff, reason: string, status: "failed" | "cancelled" = "cancelled") {
    for (const child of this.children(node.id)) if (!terminal(child)) this.cancelTree(child, reason, status);
    if (!terminal(node)) {
      node.status = status; node.result = reason;
      this.controllers.get(node.id)?.abort();
    }
    this.publish(node);
  }
  cancelRoom(groupId: string, threadId?: string) {
    for (const n of this.nodes.values()) {
      if (n.groupId === groupId && (!threadId || n.threadId === threadId) && !terminal(n)) this.cancelTree(n, "Stopped by user");
    }
  }
  cancelDirect(threadId: string, reason = "Stopped by user") {
    for (const n of this.nodes.values()) {
      if (!n.groupId && n.threadId === threadId && !terminal(n)) this.cancelTree(n, reason);
    }
  }
  activeDirect(threadId: string) {
    return [...this.nodes.values()].some(n => !n.groupId && n.threadId === threadId && !terminal(n));
  }
  /** Work this conversation handed out that has not settled yet. The
   * conversation's own node is not outstanding — only what it waits on. */
  outstandingDirect(threadId: string): RoomHandoff[] {
    return [...this.nodes.values()].filter(node => {
      if (terminal(node) || !node.parentId) return false;
      const parent = this.nodes.get(node.parentId);
      return Boolean(parent && !parent.groupId && parent.threadId === threadId);
    });
  }
  /** Stop this conversation without reaching into a teammate that is already
   * working. Its provider process is left alone: it finishes and its result
   * is still reported here. Work that never started is cancelled, because
   * nothing is lost. This conversation stops being awaited either way, so no
   * teammate result resumes a stopped chat. Returns what was left running. */
  stopAwaitingDirect(threadId: string, reason = "Stopped by user"): RoomHandoff[] {
    const left: RoomHandoff[] = [];
    for (const node of this.nodes.values()) {
      if (node.groupId || node.threadId !== threadId || terminal(node)) continue;
      for (const child of this.children(node.id)) {
        if (terminal(child)) continue;
        if (child.status === "queued") this.cancelTree(child, "Stopped before it started");
        else left.push(child);
      }
      node.status = "cancelled"; node.result = reason;
      this.controllers.get(node.id)?.abort();
      this.publish(node);
    }
    return left;
  }

  tick() {
    if (this.loadError) return;
    // Validate and expire deepest nodes first so each one is failed with its
    // own status; an ancestor's cancellation then only sweeps what is left.
    for (const n of [...this.nodes.values()].reverse()) {
      if (terminal(n)) continue;
      const error = this.hooks.validate(n, n.parentId ? this.nodes.get(n.parentId) : undefined);
      if (error || (this.now() > this.deadline(n) && !this.protectsRunner(n) && !this.owesFollowUp(n))) {
        this.cancelTree(n, error ?? this.lifetimeError(n), "failed");
      }
    }
    for (const n of this.nodes.values()) {
      const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
      if (terminal(n) && parent && !n.reported) {
        this.hooks.report(n, parent); n.reported = true; this.publish(n, parent);
      }
      if (n.status === "waiting") {
        const children = this.children(n.id);
        if (children.length && children.every(c => terminal(c) && c.reported)) { n.status = "resume"; this.publish(n); }
      }
      if (n.status !== "queued" && n.status !== "resume") continue;
      // A newly queued child starts only after its author has settled.
      if (parent && (parent.status === "source" || parent.status === "running")) continue;
      // A stopped source stops waiting; only work that never started is
      // dropped with it. A teammate mid-turn keeps its process and reports.
      if (parent && terminal(parent) && n.status === "queued") { this.cancelTree(n, "Originating request has ended"); continue; }
      if (this.hooks.busy(n)) continue;
      const root = this.root(n);
      const executionCost = 1;
      if (root.executions + executionCost > ROOM_HANDOFF_LIMITS.executions) { this.cancelTree(n, "Room execution budget exhausted", "failed"); continue; }
      const resumed = n.status === "resume";
      const childCount = this.children(n.id).length;
      root.executions += executionCost; n.status = "running"; n.startedAt = this.now();
      this.publish(n, root);
      const controller = new AbortController();
      this.controllers.set(n.id, controller);
      void this.hooks.run(n, resumed, controller.signal).then(result => {
        if (terminal(n)) return;
        n.result = result.text.slice(0, 12_000);
        if (!result.ok) this.cancelTree(n, n.result || "Room agent failed", "failed");
        else if (this.children(n.id).length > childCount) n.status = "waiting";
        else n.status = "completed";
        this.publish(n);
      }).catch(e => { this.cancelTree(n, String(e).slice(0, 1000), "failed"); })
        .finally(() => this.controllers.delete(n.id));
    }
  }
}
