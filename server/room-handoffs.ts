import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const nodeSchema = z.object({
  id: z.string(), rootId: z.string(), parentId: z.string().optional(),
  groupId: z.string().optional(), threadId: z.string(), botId: z.string(),
  key: z.string(), text: z.string(), createdAt: z.number(),
  requestBatchKey: z.string().optional(),
  status: z.enum(["source", "queued", "running", "waiting", "resume", "completed", "failed", "cancelled"]),
  result: z.string().default(""), reported: z.boolean().default(false),
  executions: z.number().int().nonnegative().default(0), startedAt: z.number().optional(),
  lastProgressAt: z.number().optional(),
  approvalGranted: z.boolean().default(false),
  kind: z.enum(["work", "assignment"]).default("work"),
  /** Turns of this node a restart cut and ran again in place. */
  restarts: z.number().int().nonnegative().default(0),
  /** Its next turn, or the one running now, follows a restart and says so:
   * "rerun" is its own cut turn run again; "cut", its own turn was cut after
   * handing out the work it now waits on; "teammates", only work it waits on
   * was cut. Cleared when that turn settles (a node ended another way keeps
   * it, inert). */
  restart: z.enum(["rerun", "cut", "teammates"]).optional(),
});
export type RoomHandoff = z.infer<typeof nodeSchema>;
export type RoomAddress = Pick<RoomHandoff, "groupId" | "threadId" | "botId">;
export const ROOM_HANDOFF_LIMITS = { depth: 4, requests: 24, executions: 48, lifetimeMs: 30 * 60_000, minRunwayMs: 10 * 60_000, queueMs: 60 * 60_000, hardCapMs: 4 * 60 * 60_000 };
/** A turn a restart cut runs again once; cut again, it ends with this. */
export const ROOM_HANDOFF_CUT_TWICE = "Interrupted by another OpenMausBot restart after resuming once; not resumed again. Some of its steps may already have taken effect.";
/** Renders elapsed milliseconds as whole minutes, or seconds under one minute. */
const duration = (ms: number) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;
const terminal = (n: RoomHandoff) => ["completed", "failed", "cancelled"].includes(n.status);

export interface RoomHandoffHooks {
  /** Recheck addresses and route permission immediately before every dispatch. */
  validate(node: RoomHandoff, parent?: RoomHandoff): string | undefined;
  busy(node: RoomHandoff): boolean;
  run(node: RoomHandoff, resumed: boolean, signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
  /** A settled child, to its requester; a root a restart ended, alone. */
  report(child: RoomHandoff, parent?: RoomHandoff): void;
  changed(groupIds: ReadonlySet<string>, directThreadIds: ReadonlySet<string>): void;
}

/** A bounded tree of addressed room turns. Waiting for children never holds a
 * room/provider queue; reporting is data, and only the named parent is resumed.
 * A turn a restart cut runs again once, in place, told to check what it
 * already did (tools may have effects); its requester is told
 * (reconcileRestart).
 */
export class RoomHandoffs {
  readonly nodes = new Map<string, RoomHandoff>();
  private readonly controllers = new Map<string, AbortController>();
  private loadError?: string;
  private readonly file: string;
  private readonly hooks: RoomHandoffHooks;
  private readonly now: () => number;
  private readonly limits: typeof ROOM_HANDOFF_LIMITS;
  /** Clocks do not run while the server is down: every time budget of a
   * tree that outlived a restart starts again here. Counts carry on. */
  private readonly bootAt: number;
  /** Set by close(): shutdown has begun. */
  private closing = false;
  /** Per-root pause accounting for the tree lifetime clock. */
  private readonly pauses = new Map<string, { accumulatedMs: number; since?: number }>();
  /** Tick-local status updates. One fsync at the end, not one per node. */
  private batch: { dirty: boolean; groups: Set<string>; threads: Set<string> } | null = null;
  /** Settlements that resolve in the same turn share one fsync. */
  private settleDirty = false;
  private settleScheduled = false;
  private deferSettle = false;
  private readonly settleGroups = new Set<string>();
  private readonly settleThreads = new Set<string>();

  constructor(file: string, hooks: RoomHandoffHooks, now: () => number = Date.now,
    limits: Partial<typeof ROOM_HANDOFF_LIMITS> = {}) {
    this.file = file; this.hooks = hooks; this.now = now; this.bootAt = now();
    this.limits = { ...ROOM_HANDOFF_LIMITS, ...limits };
    try {
      const saved = z.array(nodeSchema).max(10_000).parse(JSON.parse(readFileSync(file, "utf8")));
      const ids = new Map(saved.map(n => [n.id, n]));
      if (ids.size !== saved.length || saved.some(n => !ids.has(n.rootId) || ids.get(n.rootId)?.parentId ||
        (n.parentId && (!ids.has(n.parentId) || ids.get(n.parentId)?.rootId !== n.rootId)))) throw new Error("Invalid room handoff tree");
      for (const n of saved) this.nodes.set(n.id, n);
      this.reconcileRestart();
      this.save();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.loadError = "Room handoff storage is unreadable; repair it before sending new work.";
    }
  }

  /** A restart cut every turn that was running. None ends silently and
   * none runs again more than once:
   * - a turn that had handed out work waits for it, and its resume says the
   *   turn was cut ("cut"); nothing of it runs again;
   * - any other cut turn runs again once, in place, in its retained session,
   *   told to check what it already did first ("rerun");
   * - a rerun cut too ends failed, reported to its requester (a root, in its
   *   own conversation).
   * A requester waiting on a cut turn hears what the restart did on its
   * next turn ("teammates"). Queued work and owed resumes go ahead. */
  private reconcileRestart() {
    for (const n of this.nodes.values()) {
      const fate = this.cutFate(n);
      if (!fate) continue;
      if (fate === "wait") {
        n.status = "waiting"; n.restart = "cut";
      } else if (fate === "end") {
        n.status = "failed"; n.result = ROOM_HANDOFF_CUT_TWICE; delete n.restart;
        if (!n.parentId) n.reported = false;
      } else {
        n.status = this.children(n.id).length ? "resume" : "queued"; n.restart = "rerun"; n.restarts++;
      }
      const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
      if (parent && !terminal(parent) && !parent.restart) parent.restart = "teammates";
    }
  }
  /** What the next boot does with this node if a restart cuts it now: "wait"
   * for the work its turn handed out, run that turn "again", or "end" it
   * (its one rerun was cut too); undefined when no turn of it is running. */
  private cutFate(n: RoomHandoff): "wait" | "again" | "end" | undefined {
    if (n.status !== "source" && n.status !== "running") return undefined;
    if (n.status === "source" || this.children(n.id).some(c => c.createdAt >= (n.startedAt ?? n.createdAt))) return "wait";
    return n.restart === "rerun" ? "end" : "again";
  }
  /** The turn running in this conversation is one the next start goes on
   * with (it waits on its work, or runs again), so a shutdown's line that it
   * was cut would be false; that start says what happened instead. */
  continuesAfterRestart(threadId: string): boolean {
    return [...this.nodes.values()].some(n => {
      const fate = !n.groupId && n.threadId === threadId ? this.cutFate(n) : undefined;
      return fate === "wait" || fate === "again";
    });
  }

  /** Shutdown has begun: dispatch nothing more, and leave a turn the
   * teardown fails (or the source turn it ends) as it is, for the next boot
   * to find cut. A quit then ends where a crash does, whatever the engine.
   * A turn that still finishes keeps its result. */
  close() { this.closing = true; }

  /** What a restart did to this node's turn and to the work it waits on, for
   * the first turn after it ("" when nothing): a cut turn runs again in its
   * own conversation, so it checks before it repeats, and a requester learns
   * which of its teammates ran again. Ends with a newline. */
  restartNote(node: RoomHandoff, nameOf: (botId: string) => string): string {
    if (!node.restart) return "";
    const own = node.restart === "rerun"
      ? "OpenMausBot restarted while your previous turn here was running and cut it off; this turn continues it. First check what that turn already did (files, commits, messages, anything sent or started) and verify anything uncertain, so nothing is done twice; then finish and report as usual. A restart alone is not a blocker."
      : node.restart === "cut" ? "OpenMausBot restarted before your previous turn here finished, after it sent work to teammates. Check what that turn already did before repeating any of it." : "";
    // Only a rerun that completed is known to have finished; any other end
    // (never started, start refused, stopped or expired mid-run) may leave
    // part of it done, and its result says how it ended.
    const cut = this.children(node.id).filter(child => child.restarts > 0).map(child => `${nameOf(child.botId)} (${
      child.result === ROOM_HANDOFF_CUT_TWICE ? "cut again while resuming, so not resumed a second time: it may be partly done"
        : child.status === "completed" ? "resumed once in place and told to check what it had already done"
        : `set to resume once but ended ${child.status} before finishing, so it may be partly done: see its result`})`);
    const teammates = cut.length ? `A restart cut these teammates' turns: ${cut.join("; ")}. Check their results as usual.` : "";
    return own || teammates ? `${[own, teammates].filter(Boolean).join(" ")}\n` : "";
  }

  private save() { writeFileAtomic(this.file, JSON.stringify([...this.nodes.values()]), { mode: 0o600 }); }
  private remember(nodes: readonly RoomHandoff[], groups: Set<string>, threads: Set<string>) {
    for (const node of nodes) {
      if (node.groupId) groups.add(node.groupId);
      else threads.add(node.threadId);
    }
  }
  private emit(groups: ReadonlySet<string>, threads: ReadonlySet<string>) {
    if (groups.size === 0 && threads.size === 0) return;
    this.hooks.changed(groups, threads);
  }
  /** Acceptance and caller-visible stops. The write finishes before return,
   * so a failed disk rolls the accept back and a crash keeps the accept. */
  private commit(...nodes: RoomHandoff[]) {
    this.save();
    if (this.batch) this.batch.dirty = false;
    this.settleDirty = false;
    const groups = new Set(this.settleGroups);
    const threads = new Set(this.settleThreads);
    this.settleGroups.clear();
    this.settleThreads.clear();
    this.remember(nodes, groups, threads);
    this.emit(groups, threads);
  }
  private publish(...nodes: RoomHandoff[]) {
    if (this.batch) {
      this.batch.dirty = true;
      this.remember(nodes, this.batch.groups, this.batch.threads);
      return;
    }
    if (this.deferSettle) {
      this.settleDirty = true;
      this.remember(nodes, this.settleGroups, this.settleThreads);
      this.scheduleSettleFlush();
      return;
    }
    this.commit(...nodes);
  }
  private scheduleSettleFlush() {
    if (this.settleScheduled) return;
    if (!this.settleDirty && this.settleGroups.size === 0 && this.settleThreads.size === 0) return;
    this.settleScheduled = true;
    queueMicrotask(() => {
      this.settleScheduled = false;
      if (this.settleDirty) {
        try {
          this.save();
          this.settleDirty = false;
        } catch (error) {
          // The next tick writes the same map. A throw here would be uncaught.
          console.error("room handoffs:", error);
          return;
        }
      }
      const groups = new Set(this.settleGroups);
      const threads = new Set(this.settleThreads);
      this.settleGroups.clear();
      this.settleThreads.clear();
      this.emit(groups, threads);
    });
  }
  /** Write what the open tick changed so far, now. Change notices still go
   * out once, at the end of the tick. */
  private saveBatch() {
    if (!this.batch || (!this.batch.dirty && !this.settleDirty)) return;
    this.save();
    this.batch.dirty = false;
    this.settleDirty = false;
  }
  private flushBatch() {
    const batch = this.batch;
    this.batch = null;
    if (!batch) return;
    // Keep failed tick writes in the same retry ledger as settlements. Do not
    // leave a batch open: user accepts/stops must still save immediately.
    for (const id of batch.groups) this.settleGroups.add(id);
    for (const id of batch.threads) this.settleThreads.add(id);
    this.settleDirty ||= batch.dirty;
    if (this.settleDirty) {
      this.save();
      this.settleDirty = false;
    }
    const groups = new Set(this.settleGroups);
    const threads = new Set(this.settleThreads);
    this.settleGroups.clear();
    this.settleThreads.clear();
    this.emit(groups, threads);
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

  /** The tree lifetime clock pauses while any node in the tree is actively
   * executing: the budget bounds coordination sprawl, not the runtime of
   * dispatched work. Accounting is in-memory: no pause span survives a
   * restart, and none needs to, since a surviving tree's clocks start again
   * at boot (bootAt). */
  private trackExecutionPauses(): void {
    const now = this.now();
    const executing = new Set<string>();
    // Roots that still own unsettled nodes. A conversation stopped while a
    // dispatched teammate executes leaves a terminal root above live work;
    // pause accounting must survive that root until the whole tree settles.
    const unsettled = new Set<string>();
    for (const n of this.nodes.values()) {
      if (terminal(n)) continue;
      unsettled.add(n.rootId);
      if (n.status === "running") executing.add(n.rootId);
    }
    for (const rootId of executing) {
      const pause = this.pauses.get(rootId) ?? { accumulatedMs: 0 };
      pause.since ??= now;
      this.pauses.set(rootId, pause);
    }
    for (const [rootId, pause] of this.pauses) {
      if (pause.since != null && !executing.has(rootId)) {
        pause.accumulatedMs += now - pause.since;
        pause.since = undefined;
      }
      const root = this.nodes.get(rootId);
      if (!root || !unsettled.has(rootId)) this.pauses.delete(rootId);
    }
  }
  private pausedMs(root: RoomHandoff): number {
    const pause = this.pauses.get(root.id);
    if (!pause) return 0;
    return pause.accumulatedMs + (pause.since != null ? this.now() - pause.since : 0);
  }
  /** A clock anchor, never before this boot: downtime is nobody's budget. */
  private since(at: number): number {
    return Math.max(at, this.bootAt);
  }
  /** The lifetime budget consumed so far: wall clock minus paused time. */
  private effectiveAgeMs(root: RoomHandoff): number {
    return Math.max(0, this.now() - this.since(root.createdAt) - this.pausedMs(root));
  }
  /** The wall-clock cap is a stall window, not a total-age limit: it is
   * measured from the tree's creation or its last durable progress,
   * whichever is later. */
  private capOrigin(root: RoomHandoff): number {
    return this.since(root.lastProgressAt ?? root.createdAt);
  }
  /** Records durable progress on the root — a dispatch, a settlement, or a
   * cancellation — restarting the hard-cap stall window from now. */
  private stampProgress(root: RoomHandoff): void {
    root.lastProgressAt = Math.max(root.lastProgressAt ?? root.createdAt, this.now());
  }
  /** The earliest moment this node may be failed for lifetime: the tree
   * ceiling, a running node's own start plus a minimum runway, or, for work
   * parked in a busy teammate's queue, its own queue window (#1238). The
   * wall-clock hard cap clamps every extension: a tree that never stops
   * executing still dies, so runway extensions cannot compound forever. */
  private deadline(n: RoomHandoff): number {
    const anchor = this.since(n.status === "running" ? n.startedAt ?? n.createdAt : n.createdAt);
    const root = this.root(n);
    const ceiling = n.status === "queued" && n.executions === 0
      ? anchor + this.limits.queueMs
      : this.since(root.createdAt) + this.limits.lifetimeMs + this.pausedMs(root);
    const normal = Math.min(Math.max(ceiling, anchor + this.limits.minRunwayMs), this.capOrigin(root) + this.limits.hardCapMs);
    // An in-flight synthesis turn keeps at least the runway its dispatch
    // promised even when the hard cap lands mid-run; the cap still clamps
    // the deadline, so a hung synthesis dies at that edge instead of
    // becoming immortal.
    if (n.status === "running" && this.owesOnlySynthesis(n)) {
      return Math.max(normal, anchor + this.limits.minRunwayMs);
    }
    return normal;
  }
  /** An ancestor past its ceiling is not failed while a descendant is still
   * running inside its own runway; cancelling would cascade into that work. */
  private protectsRunner(n: RoomHandoff): boolean {
    return this.children(n.id).some(c => !terminal(c) && ((c.status === "running" && this.now() <= this.deadline(c)) || this.protectsRunner(c)));
  }
  /** A parent still owes the follow-up execution that decides on its
   * children's results; the ceiling defers to that execution's own runway.
   * A child parked in a queue has produced nothing to decide on yet. */
  private owesFollowUp(n: RoomHandoff): boolean {
    if (n.status === "resume") return true;
    if (n.status !== "waiting") return false;
    const children = this.children(n.id);
    return (children.length > 0 && children.every(c => terminal(c))) ||
      children.some(c => this.owesFollowUp(c) || (c.status === "queued" && c.executions === 0));
  }
  /** A node whose children have all settled owes only its own synthesis
   * turn: the step that returns their results to the requester. The hard
   * cap must not kill that turn mid-flight or starve it of its dispatch.
   * A synthesis owed to a teammate who is permanently busy is a stall, not
   * progress, and stays subject to the cap. */
  private owesOnlySynthesis(n: RoomHandoff): boolean {
    const children = this.children(n.id);
    return children.length > 0 && children.every(c => terminal(c)) &&
      (n.status === "running" || (n.status === "resume" && !this.hooks.busy(n)));
  }
  /** Names the budget, the node's status, and the elapsed time. Work that
   * never started reports the queue window it waited out, not the tree's. */
  private lifetimeError(n: RoomHandoff): string {
    if (n.status === "queued" && n.executions === 0) {
      return `Room handoff queue budget exhausted: ${n.restart === "rerun" ? "not resumed after a restart" : "never started"} while waiting for a busy teammate after ${duration(this.now() - this.since(n.createdAt))} of the ${duration(this.limits.queueMs)} queue window`;
    }
    const root = this.root(n);
    return `Room handoff lifetime budget exhausted: node was ${n.status} after ${duration(this.effectiveAgeMs(root))} of the ${duration(this.limits.lifetimeMs)} tree lifetime`;
  }
  /** The wall-clock ceiling ignores pauses: it is what stops a tree whose
   * execution never pauses long enough to age its lifetime budget. */
  private hardCapError(n: RoomHandoff): string {
    const root = this.root(n);
    const first = `Room handoff hard cap exhausted: node was ${n.status} after ${duration(this.now() - this.since(root.createdAt))} of the ${duration(this.limits.hardCapMs)} wall-clock cap`;
    // Graceful expiry: settled children are real work the tree produced,
    // so the expiry still carries a bounded digest of their results. A
    // wide tree cannot turn the error into a dump: each result is tailed
    // to 512 chars and the digest to 4 KiB, with the elided count named.
    const settled = [...this.nodes.values()]
      .filter(x => x.rootId === root.id && x.parentId && terminal(x))
      .map(x => `${x.key} [${x.status}] ${x.result.slice(-512)}`);
    if (!settled.length) return first;
    const lines: string[] = [];
    let used = 0;
    for (const line of settled) {
      if (used + line.length + 1 > 4096) break;
      lines.push(line); used += line.length + 1;
    }
    const elided = settled.length - lines.length;
    return `${first}\n${lines.join("\n")}${elided ? `\n(+${elided} elided)` : ""}`;
  }

  enqueue(source: RoomAddress, generation: string, parentId: string | undefined,
    target: RoomAddress, key: string, text: string, approvalGranted = false,
    rework = false, sourceText = "", requestBatchKey?: string): { node: RoomHandoff; duplicate: boolean } {
    if (this.loadError) throw new Error(this.loadError);
    let parent = parentId ? this.nodes.get(parentId) : this.nodes.get(generation);
    if (parentId && (!parent || parent.status !== "running")) throw new Error("The originating room task is no longer running");
    if (parent && (parent.groupId !== source.groupId || parent.threadId !== source.threadId || parent.botId !== source.botId)) {
      throw new Error("The handoff belongs to a different room speaker");
    }
    const fresh = !parent;
    parent ??= { ...source, id: generation, rootId: generation, key: "root", text: sourceText.slice(0, 12_000), createdAt: this.now(), status: "source", result: "", reported: true, executions: 0, approvalGranted: false, kind: "work", restarts: 0 };
    const kind = target.groupId && target.groupId === source.groupId ? "assignment" : "work";
    const path = this.path(parent);
    if (path.some(n => n.botId === target.botId && (!n.groupId || !target.groupId || n.groupId === target.groupId))) {
      throw new Error("Cannot assign work back to an ancestor; results return automatically");
    }
    // The same text to the same teammate and place under one parent is one
    // request, so a repeat lands on it. Only rework=true runs a finished or
    // failed one again.
    const existing = this.children(parent.id).findLast(n => n.botId === target.botId && n.groupId === target.groupId && n.text === text);
    if (existing && !(rework && terminal(existing))) return { node: existing, duplicate: true };
    if (!rework && this.children(parent.id).some(n => n.kind === kind &&
      n.groupId === target.groupId && n.botId === target.botId && n.status === "completed")) {
      throw new Error("This agent already completed your assignment. Do not send acknowledgements or approvals as new work. Finish with your decision; results return automatically. Only use rework=true for concrete additional work.");
    }
    if (kind === "work" && target.groupId && path.some(n => n.groupId === target.groupId)) throw new Error("A room request cannot return to an ancestor room; results are returned automatically");
    // The path includes the source root, so its work-node count is the
    // proposed edge depth: four edges are allowed; the fifth is refused.
    if (kind === "work" && path.filter(n => n.kind === "work").length > this.limits.depth) throw new Error("Room handoff depth limit reached");
    const root = fresh ? parent : this.root(parent);
    const count = [...this.nodes.values()].filter(n => n.rootId === parent!.rootId && n.parentId).length;
    if (count >= this.limits.requests) throw new Error("Room handoff budget exhausted");
    // Refuse work the tree's lifetime budget cannot honestly serve: a node
    // accepted in the root's last minutes would be doomed at enqueue time.
    // The wall-clock hard cap ignores pauses, so the runway actually
    // available is the shorter of the two remainders.
    const lifetimeRemaining = this.limits.lifetimeMs - this.effectiveAgeMs(root);
    const hardCapRemaining = this.capOrigin(root) + this.limits.hardCapMs - this.now();
    const remaining = Math.min(lifetimeRemaining, hardCapRemaining);
    if (remaining < this.limits.minRunwayMs) {
      throw new Error(`Room handoff budget exhausted: only ${duration(Math.max(remaining, 0))} of the ${duration(this.limits.lifetimeMs)} tree lifetime remains`);
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
      kind, restarts: 0, ...(target.groupId && requestBatchKey ? { requestBatchKey } : {}) };
    const problem = this.hooks.validate(node, parent);
    if (problem) throw new Error(problem);
    if (fresh) this.nodes.set(parent.id, parent);
    this.nodes.set(node.id, node);
    try { this.commit(node, parent); } catch (e) { this.nodes.delete(node.id); if (fresh) this.nodes.delete(parent.id); throw e; }
    return { node, duplicate: false };
  }

  /** A room brief is displayed once; each recipient keeps its own execution and result. */
  sharedRequest(node: RoomHandoff): { id: string; botIds: string[] } {
    const batch = node.groupId && node.requestBatchKey && node.parentId
      ? this.children(node.parentId).filter(n => n.requestBatchKey === node.requestBatchKey &&
        n.groupId === node.groupId && n.threadId === node.threadId && n.text === node.text)
      : [node];
    return { id: batch[0]?.id ?? node.id, botIds: batch.map(n => n.botId) };
  }

  sourceSettled(generation: string, ok: boolean) {
    const node = this.nodes.get(generation);
    if (!node || node.status !== "source" || (!ok && this.closing)) return;
    // An accepted assignment belongs to the queue, not the provider that
    // submitted it. A failed/expired source turn must not erase that work.
    // Explicit Stop, deletion and revoked routes still cancel separately.
    if (!ok) node.result = "The originating turn ended before its teammates returned.";
    node.status = "waiting";
    this.publish(node);
  }

  cancelTree(node: RoomHandoff, reason: string, status: "failed" | "cancelled" = "cancelled") {
    for (const child of this.children(node.id)) if (!terminal(child)) this.cancelTree(child, reason, status);
    if (!terminal(node)) {
      node.status = status; node.result = reason;
      this.controllers.get(node.id)?.abort();
      this.stampProgress(this.root(node));
    }
    // Settlement closes the paused span now, not at the next periodic tick.
    this.trackExecutionPauses();
    this.publish(node);
  }
  /** A harness stop (a provider reload) passes its own cause and fails the
   * work, so a requester never reads it as the person's Stop. */
  cancelRoom(groupId: string, threadId?: string, reason = "Stopped by user", status: "failed" | "cancelled" = "cancelled") {
    for (const n of this.nodes.values()) {
      if (n.groupId === groupId && (!threadId || n.threadId === threadId) && !terminal(n)) this.cancelTree(n, reason, status);
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
  /** The conversation that assigned the unsettled direct work running in
   * this thread, or undefined when nothing it does is awaited. */
  assignerOf(threadId: string): RoomHandoff | undefined {
    for (const node of this.nodes.values()) {
      if (terminal(node) || !node.parentId || node.groupId || node.threadId !== threadId) continue;
      const parent = this.nodes.get(node.parentId);
      if (parent) return parent;
    }
    return undefined;
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
  /** Teammate work that has not settled yet, as ids only: who asked, who is
   * working on it, and where. The request and result text stay out, so the
   * Team map can show the link without reading anyone's conversation. */
  liveEdges(): Array<{ sourceBotId: string; targetBotId: string; state: "queued" | "running"; threadId: string; groupId?: string }> {
    return [...this.nodes.values()].flatMap(node => {
      if (terminal(node) || !node.parentId) return [];
      const parent = this.nodes.get(node.parentId);
      if (!parent || parent.botId === node.botId) return [];
      return [{
        sourceBotId: parent.botId, targetBotId: node.botId,
        state: node.status === "queued" ? "queued" as const : "running" as const,
        threadId: node.threadId, ...(node.groupId ? { groupId: node.groupId } : {}),
      }];
    });
  }
  /** Stop this conversation without reaching into a teammate that is already
   * working. Its provider process is left alone: it finishes and its result
   * is still reported here. Work that never started is cancelled, because
   * nothing is lost, and so is a cut turn still owed its rerun: nothing of it
   * runs, and Stop means stop. This conversation stops being awaited either
   * way, so no teammate result resumes a stopped chat. Returns what was left
   * running. */
  stopAwaitingDirect(threadId: string, reason = "Stopped by user"): RoomHandoff[] {
    const left: RoomHandoff[] = [];
    for (const node of this.nodes.values()) {
      if (node.groupId || node.threadId !== threadId || terminal(node)) continue;
      for (const child of this.children(node.id)) {
        if (terminal(child)) continue;
        if (child.status === "queued") this.cancelTree(child, child.restart === "rerun" ? "Stopped before it resumed" : "Stopped before it started");
        else left.push(child);
      }
      node.status = "cancelled"; node.result = reason;
      this.controllers.get(node.id)?.abort();
      this.trackExecutionPauses();
      this.publish(node);
    }
    return left;
  }

  tick() {
    if (this.loadError || this.closing) return;
    this.batch = { dirty: false, groups: new Set(), threads: new Set() };
    try {
      this.tickBody();
    } finally {
      this.flushBatch();
    }
  }

  private tickBody() {
    this.trackExecutionPauses();
    // Validate and expire deepest nodes first so each one is failed with its
    // own status; an ancestor's cancellation then only sweeps what is left.
    // The hard cap overrides the runner and follow-up protections: it is the
    // bound that stops a tree whose execution never pauses. A tree whose only
    // remaining obligation is its own synthesis turn is spared, so settled
    // results are returned instead of dying inside a failed tree.
    for (const n of [...this.nodes.values()].reverse()) {
      if (terminal(n)) continue;
      const error = this.hooks.validate(n, n.parentId ? this.nodes.get(n.parentId) : undefined);
      const hardCapped = !this.owesOnlySynthesis(n) && this.now() >= this.capOrigin(this.root(n)) + this.limits.hardCapMs;
      if (error || hardCapped || (this.now() > this.deadline(n) && !this.protectsRunner(n) && !this.owesFollowUp(n))) {
        this.cancelTree(n, error ?? (hardCapped ? this.hardCapError(n) : this.lifetimeError(n)), "failed");
      }
    }
    for (const n of this.nodes.values()) {
      const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
      if (terminal(n) && !n.reported) {
        this.saveBatch();
        this.hooks.report(n, parent); n.reported = true; this.publish(...parent ? [n, parent] : [n]);
      }
      if (n.status === "waiting") {
        const children = this.children(n.id);
        if (children.length && children.every(c => terminal(c) && c.reported)) { n.status = "resume"; this.publish(n); }
      }
      if (n.status !== "queued" && n.status !== "resume") continue;
      // Independent conversations can start as soon as work is accepted.
      // Same-room speakers still serialize; never overlap their shared chat.
      if (parent && (parent.status === "source" || parent.status === "running") &&
        (parent.threadId === n.threadId || (n.groupId && n.groupId === parent.groupId))) continue;
      // A stopped source stops waiting; only work that never started is
      // dropped with it. A teammate mid-turn keeps its process and reports,
      // and so does one the person left working that a restart then cut.
      if (parent && terminal(parent) && n.status === "queued" && n.startedAt === undefined) { this.cancelTree(n, "Originating request has ended"); continue; }
      if (this.hooks.busy(n)) continue;
      const root = this.root(n);
      const executionCost = 1;
      if (root.executions + executionCost > this.limits.executions) { this.cancelTree(n, "Room execution budget exhausted", "failed"); continue; }
      const resumed = n.status === "resume";
      const childCount = this.children(n.id).length;
      const before = { status: n.status, startedAt: n.startedAt, lastProgressAt: root.lastProgressAt,
        pause: this.pauses.get(root.id), since: this.pauses.get(root.id)?.since };
      root.executions += executionCost; n.status = "running"; n.startedAt = this.now();
      this.stampProgress(root);
      // Open the pause at the moment execution starts, not at the next tick:
      // the lifetime clock must not charge the gap before observation.
      const pause = this.pauses.get(root.id) ?? { accumulatedMs: 0 };
      pause.since ??= this.now();
      this.pauses.set(root.id, pause);
      this.publish(n, root);
      // The file must say running before the child starts. Everything this
      // tick changed so far shares this one write. If it fails, the node is
      // put back as it was and nothing starts; the next tick tries again.
      try {
        this.saveBatch();
      } catch (error) {
        root.executions -= executionCost;
        n.status = before.status;
        if (before.startedAt === undefined) delete n.startedAt; else n.startedAt = before.startedAt;
        if (before.lastProgressAt === undefined) delete root.lastProgressAt; else root.lastProgressAt = before.lastProgressAt;
        if (!before.pause) this.pauses.delete(root.id);
        else before.pause.since = before.since;
        throw error;
      }
      const controller = new AbortController();
      this.controllers.set(n.id, controller);
      void this.hooks.run(n, resumed, controller.signal).then(result => {
        this.deferSettle = true;
        try {
          if (terminal(n) || (!result.ok && this.closing)) return;
          delete n.restart;
          n.result = result.text.slice(0, 12_000);
          if (this.children(n.id).length > childCount) n.status = "waiting";
          else if (!result.ok) this.cancelTree(n, n.result || "Room agent failed", "failed");
          else { n.status = "completed"; this.stampProgress(root); }
          // Close the paused span with the settlement itself: work enqueued
          // before the next periodic tick must be admitted against the aged
          // budget, not the still-open pause's overstated runway.
          this.trackExecutionPauses();
          this.publish(n);
        } finally {
          this.deferSettle = false;
          this.scheduleSettleFlush();
        }
      }).catch(e => {
        this.deferSettle = true;
        try {
          if (terminal(n) || this.closing) return;
          delete n.restart;
          n.result = String(e).slice(0, 1000);
          if (this.children(n.id).length > childCount) {
            n.status = "waiting";
            this.trackExecutionPauses();
            this.publish(n);
          } else this.cancelTree(n, n.result, "failed");
        } finally {
          this.deferSettle = false;
          this.scheduleSettleFlush();
        }
      })
        .finally(() => this.controllers.delete(n.id));
    }
  }
}
