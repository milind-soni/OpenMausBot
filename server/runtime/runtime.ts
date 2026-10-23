          import { randomUUID } from "node:crypto";

import { composeEnvelope } from "./envelope.ts";
import { assignmentLevel } from "./level.ts";
import type { RuntimeStore } from "./store.ts";
import { asking, awaited, childrenSince, clip, continuations, CUT_TWICE, duration, isTerminal, loopStop, nextGuard, outwardDetail, ownsConversation, path, restartNote, wakeOwner } from "./tree.ts";
import { DEFAULT_LIMITS, type Assignment, type Assignee, type Clock, type EndResult, type EnqueueRequest, type EnqueueResult, type EnvelopeNames,
  type EventKind, type InboxItem, type InboxKind, type Level, type Limits, type LiveEdge, type Origin, type Outcome, type Owner,
  type Reply, type Requester, type RunInput, type RunResult, type StatusView, type TurnRunner } from "./types.ts";

export interface RuntimeOptions {
  /** Default: Date.now and performance.now. */
  clock?: Clock;
  /** Merged over DEFAULT_LIMITS. */
  limits?: Partial<Limits>;
  level?: typeof assignmentLevel;
  log?: (line: string) => void;
}

export interface BeginRequest {
  id?: string;
  origin: Origin;
  /** person | routine_run | external_runtime */
  requester: Requester;
  /** The requesting conversation's own bot and thread. */
  assignee: Assignee;
  /** The person's message or the routine's instructions (at most 12 000 characters). */
  brief: string;
  level: Level;
  /** Default "resume"; external runtimes use "poll". */
  reply?: Reply;
  goalRunId?: string;
}

const BRIEF_MAX = 12_000;
const RESULT_MAX = 12_000;
const DETAIL_MAX = 400;

const defaultClock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };

/** `interruption`: a resume for a teammate's question while other work is still out; the node's restart note waits for its real resume.
 * `carried`: the settled children whose results the turn's input carried; one that settles later owes the node another resume. */
interface LiveTurn { controller: AbortController; rootId: string; activeAt: number; interruption: boolean; carried: ReadonlySet<string> }

type TerminalStatus = "completed" | "failed" | "cancelled";

export class Runtime {
  readonly limits: Limits;
  private readonly store: RuntimeStore;
  private readonly runner: TurnRunner;
  private readonly clock: Clock;
  private readonly level: typeof assignmentLevel;
  private readonly log: (line: string) => void;
  private readonly bootAt: number;
  private opened = false;
  private closing = false;
  private ticking = false;
  private readonly turns = new Map<string, LiveTurn>();
  private readonly rootActivity = new Map<string, number>();
  private readonly admissionNoted = new Set<string>();
  private readonly reportDue = new Set<string>();
  private batch: Map<string, Assignment> | null = null;
  private lastThrew = false;

  constructor(store: RuntimeStore, runner: TurnRunner, options: RuntimeOptions = {}) {
    this.store = store;
    this.runner = runner;
    this.clock = options.clock ?? defaultClock;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.level = options.level ?? assignmentLevel;
    this.log = options.log ?? (line => console.error("runtime:", line));
    this.bootAt = this.clock.now();
  }


  open(): void {
    if (this.opened) return;
    this.opened = true;
    const now = this.clock.now();
    const live = this.store.all({ nonTerminal: true }).sort((a, b) => b.depth - a.depth);
    this.withBatch(() => {
      for (const snapshot of live) {
        const n = this.store.get(snapshot.id);
        if (!n || isTerminal(n)) continue;
        if (n.status === "needs_input") {
          this.store.update(n, { kind: "restart_reconciled", at: now, detail: "needs_input: parked again" });
          this.touch(n);
          this.safe("park", () => this.runner.park(n, n.question ?? "", true));
          continue;
        }
        if (n.status !== "running") continue;
        const handedOut = childrenSince(this.store, n).length > 0;
        const outward = handedOut ? [] : this.outwardOf(n);
        if (handedOut) {
          n.status = "waiting"; n.restart = "cut"; n.lastActivityAt = now;
          this.store.update(n, { kind: "restart_reconciled", at: now, detail: "waiting: cut after handing out work" });
          this.touch(n);
        } else if (outward.length > 0) {
          this.store.update(n, { kind: "restart_reconciled", at: now, detail: "failed: outward action done" });
          this.settle(n, "failed", "interrupted", outwardDetail(outward));
        } else if (n.restart === "rerun") {
          this.store.update(n, { kind: "restart_reconciled", at: now, detail: "failed: cut twice" });
          this.settle(n, "failed", "interrupted", CUT_TWICE);
        } else {
          n.restart = "rerun"; n.restarts += 1; n.lastActivityAt = now;
          n.status = this.store.children(n.id).length ? "resume" : "queued";
          this.store.update(n, { kind: "restart_reconciled", at: now, detail: `${n.status}: rerun ${n.restarts}` });
          this.touch(n);
        }
        const parent = n.parentId ? this.store.get(n.parentId) : undefined;
        if (parent && !isTerminal(parent) && !parent.restart) {
          parent.restart = "teammates";
          this.store.update(parent, { kind: "restart_reconciled", at: now, detail: `${parent.status}: teammates cut` });
          this.touch(parent);
        }
      }
      for (const n of this.store.all()) if (isTerminal(n) && n.reportedAt === undefined) this.reportDue.add(n.id);
    });
  }

  begin(req: BeginRequest): Assignment {
    const now = this.clock.now();
    const id = req.id ?? randomUUID();
    const root: Assignment = {
      id, rootId: id, depth: 0, origin: req.origin, requester: req.requester, assignee: req.assignee,
      mode: "work", reply: req.reply ?? "resume", brief: clip(req.brief, BRIEF_MAX), status: "running",
      level: req.level, levelSource: "own", executions: 1, restarts: 0, createdAt: now, startedAt: now, lastActivityAt: now,
      result: "", rework: false, budgets: { since: now, requests: 0, executions: 1, wakes: 0 }, version: 1,
      ...(req.goalRunId ? { goalRunId: req.goalRunId } : {}),
    };
    this.store.transaction(() => {
      this.store.insert(root, { kind: "enqueued", at: now, detail: "queued: root" });
      this.store.update(root, { kind: "started", at: now, detail: `running: turn 1 (host), level ${root.level}` });
    });
    this.touch(root);
    return root;
  }

  end(rootId: string, result: EndResult): void {
    const n = this.store.get(rootId);
    if (!n || n.parentId !== undefined || n.status !== "running") { this.log(`end(${rootId}): not a running root`); return; }
    if (!result.ok && !result.needsInput && !result.continue && this.closing) return;
    const live = this.turns.get(rootId);
    // Dropping the handle without an abort makes turnEnded ignore the run() result that follows.
    this.turns.delete(rootId);
    const evidence = result.evidence ? { evidence: result.evidence } : {};
    const outcome: RunResult = result.needsInput
      ? { kind: "needs_input", question: result.needsInput.question, ...(result.needsInput.cards ? { cards: result.needsInput.cards } : {}), ...evidence }
      : result.continue
        ? { kind: "continue", text: result.text, note: result.continue.note, ...(result.continue.handoffPath ? { handoffPath: result.continue.handoffPath } : {}), ...evidence }
        : result.ok
          ? { kind: "completed", text: result.text, ...evidence }
          : { kind: "failed", outcome: result.stalled ? "stalled" : "provider_error", text: result.text, ...evidence };
    try {
      this.withBatch(() => this.finishTurn(n, outcome, live));
    } catch (error) {
      this.log(`end(${rootId}) failed: ${String(error)}`);
    }
  }

  /** Remove terminal trees that finished before `before`. Returns rows removed. */
  prune(before: number): number {
    return this.store.prune(before);
  }

  /** Hand work to a teammate from a running node. Never throws. */
  enqueue(req: EnqueueRequest): EnqueueResult {
    try {
      return this.withBatch(() => this.admit(req));
    } catch (error) {
      this.log(`enqueue failed: ${String(error)}`);
      return { ok: false, reason: `The request could not be recorded: ${String(error)}`, outcome: "refused" };
    }
  }

  private admit(req: EnqueueRequest): EnqueueResult {
    const refuse = (reason: string, outcome: "refused" | "budget" = "refused"): EnqueueResult => ({ ok: false, reason, outcome });
    const now = this.clock.now();
    const parent = req.parentId ? this.store.get(req.parentId) : undefined;
    if (req.parentId && !parent) return refuse("The requesting turn no longer exists");
    if (parent && parent.status !== "running") return refuse("The requesting turn is not running");
    const brief = clip(req.brief, BRIEF_MAX);
    const mode = req.mode ?? "work";
    const lineage = parent ? path(this.store, parent) : [];
    const root = lineage[0];
    const target = req.assignee;
    if (lineage.some(a => a.assignee.botId === target.botId &&
      (!a.assignee.destination.groupId || !target.destination.groupId || a.assignee.destination.groupId === target.destination.groupId))) {
      return refuse("Cannot assign work back to an ancestor; results return automatically");
    }
    if (parent) {
      const existing = this.store.children(parent.id).findLast(c => c.brief === brief && c.mode === mode && c.assignee.botId === target.botId &&
        c.assignee.destination.threadId === target.destination.threadId && c.assignee.destination.groupId === target.destination.groupId);
      if (existing && !(req.rework && isTerminal(existing))) return { ok: true, assignment: existing, duplicate: true };
      if (parent.depth + 1 > this.limits.depth) return refuse(`Assignment depth limit reached (${this.limits.depth})`);
      if (root?.budgets && root.budgets.requests + 1 > this.limits.requests) {
        this.store.update(root, { kind: "budget", at: now, detail: `requests: ${root.budgets.requests} since last progress` });
        return refuse(`Request budget exhausted: ${this.limits.requests} requests without progress`, "budget");
      }
    }
    const chiefLineage = Boolean(req.requester.chief) || lineage.some(a => a.requester.chief === true);
    const { level, source } = this.level({ own: req.levels.own, chief: req.levels.chief, origin: (root ?? req).origin.kind, chiefLineage,
      driverKind: req.driverKind });
    const node: Assignment = {
      id: randomUUID(), rootId: parent ? parent.rootId : "", ...(parent ? { parentId: parent.id } : {}), depth: parent ? parent.depth + 1 : 0,
      origin: root ? root.origin : req.origin, requester: req.requester, assignee: target, mode,
      reply: req.reply ?? (mode === "notify" ? "none" : "resume"), brief, ...(req.doneWhen ? { doneWhen: req.doneWhen } : {}),
      status: "queued", level, levelSource: source, executions: 0, restarts: 0, createdAt: now, lastActivityAt: now, result: "",
      rework: Boolean(req.rework), ...(req.approved !== undefined ? { approved: req.approved } : {}),
      ...(req.batchKey !== undefined ? { batchKey: req.batchKey } : {}), version: 1,
    };
    if (!parent) { node.rootId = node.id; node.budgets = { since: now, requests: 0, executions: 0, wakes: 0 }; }
    const problem = this.safe("validate", () => this.runner.validate(node, parent));
    if (this.lastThrew) return refuse("The host could not validate the request now");
    if (problem) return refuse(problem);
    this.store.transaction(() => {
      this.store.insert(node, { kind: "enqueued", at: now, detail: "queued" });
      if (root?.budgets) { root.budgets.requests += 1; this.store.update(root); }
    });
    this.touch(node, ...root ? [root] : []);
    return { ok: true, assignment: node, duplicate: false };
  }

  tick(): void {
    if (!this.opened) this.open();
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      this.withBatch(() => this.tickBody());
    } finally {
      this.ticking = false;
    }
  }

  private tickBody(): void {
    const now = this.clock.now();
    const mono = this.clock.monotonic();
    const live = this.store.all({ nonTerminal: true });
    for (const snapshot of [...live].sort((a, b) => b.depth - a.depth)) {
      const n = this.store.get(snapshot.id);
      if (!n || isTerminal(n)) continue;
      if (n.status === "queued" && !n.continuation && now - this.since(n.lastActivityAt) > this.limits.queueMs) {
        this.cancelTree(n, n.executions > 0 ? "not resumed" : "never started", "failed", "expired");
      } else if (n.status === "needs_input" && this.inputExpires(n) && now - this.since(n.lastActivityAt) > this.limits.inputWaitMs) {
        this.cancelTree(n, "the person did not answer", "failed", "expired");
      } else if (n.status === "running") {
        const turn = this.turns.get(n.id);
        if (turn && mono - turn.activeAt > this.limits.turnStallMs) {
          this.cancelTree(n, `no activity for ${duration(this.limits.turnStallMs)}`, "failed", "stalled");
        }
      }
    }
    for (const snapshot of [...live].sort((a, b) => b.depth - a.depth)) {
      const n = this.store.get(snapshot.id);
      if (!n || isTerminal(n)) continue;
      const parent = n.parentId ? this.store.get(n.parentId) : undefined;
      const problem = this.safe("validate", () => this.runner.validate(n, parent));
      if (this.lastThrew || !problem) continue;
      this.cancelTree(n, problem, "failed", "refused");
    }
    for (const rootId of new Set(live.map(n => n.rootId))) {
      const root = this.store.get(rootId);
      if (!root || isTerminal(root)) continue;
      const anchor = Math.max(this.since(root.lastActivityAt), this.rootActivity.get(rootId) ?? 0);
      if (now - anchor <= this.limits.stallMs) continue;
      const tree = this.store.all({ rootId });
      if (tree.some(n => n.status === "needs_input" || (n.status === "queued" && n.continuation !== undefined))) continue;
      this.store.update(root, { kind: "stalled", at: now, detail: `no progress for ${duration(now - anchor)}` });
      this.cancelTree(root, `no progress for ${duration(this.limits.stallMs)}`, "failed", "stalled");
    }
    for (const id of Array.from(this.reportDue)) {
      const n = this.store.get(id);
      if (!n || !isTerminal(n)) { this.reportDue.delete(id); continue; }
      this.report(n, false);
    }
    for (const snapshot of live) {
      if (snapshot.status !== "waiting") continue;
      const n = this.store.get(snapshot.id);
      if (!n || n.status !== "waiting") continue;
      const due = this.resumeReason(n);
      if (!due) continue;
      if (due === "settled" && !n.parentId && n.reply === "poll") {
        this.settle(n, "completed", "done");
      } else {
        n.status = "resume";
        this.store.update(n, { kind: "resume_due", at: now, detail: due === "settled" ? "resume" : "resume: a teammate asks" });
        this.touch(n);
      }
    }
    this.dispatchDue();
  }

  private dispatchDue(): void {
    const live = this.store.all({ nonTerminal: true });
    const busyThreads = new Set(live.filter(n => n.status === "running").map(n => n.assignee.destination.threadId));
    for (const snapshot of live) {
      if (snapshot.status !== "queued" && snapshot.status !== "resume") continue;
      const n = this.store.get(snapshot.id);
      if (!n || (n.status !== "queued" && n.status !== "resume")) continue;
      if (n.status === "resume" && n.restart !== "rerun" && !this.resumeReason(n)) {
        n.status = "waiting";
        this.store.update(n, { kind: "waiting", at: this.clock.now(), detail: "waiting: nothing left to resume for" });
        this.touch(n);
        continue;
      }
      const thread = n.assignee.destination.threadId;
      // Same-conversation turns never overlap; same-room speakers take turns.
      if (busyThreads.has(thread)) continue;
      const parent = n.parentId ? this.store.get(n.parentId) : undefined;
      const group = n.assignee.destination.groupId;
      if (parent?.status === "running" && group !== undefined && parent.assignee.destination.groupId === group) continue;
      const resumed = n.status === "resume";
      if (!resumed) {
        const root = n.parentId ? this.store.get(n.rootId) : n;
        if (root?.budgets && root.budgets.executions + 1 > this.limits.executions) {
          this.cancelTree(n, `${this.limits.executions} turns without progress`, "failed", "budget");
          continue;
        }
      }
      const problem = this.safe("validate", () => this.runner.validate(n, parent));
      if (this.lastThrew) continue;
      if (problem) { this.cancelTree(n, problem, "failed", "refused"); continue; }
      const can = this.safe("canStart", () => this.runner.canStart(n));
      if (can !== true) {
        if (typeof can === "string" && !this.admissionNoted.has(n.id)) {
          this.admissionNoted.add(n.id);
          this.store.update(n, { kind: "admitted", at: this.clock.now(), detail: `waiting: ${can}` });
          this.touch(n);
        }
        continue;
      }
      if (this.dispatch(n, parent, resumed)) busyThreads.add(thread);
    }
  }

  private dispatch(n: Assignment, parent: Assignment | undefined, resumed: boolean): boolean {
    const now = this.clock.now();
    const root = n.parentId ? this.store.get(n.rootId) : n;
    if (!root) { this.log(`dispatch(${n.id}): root ${n.rootId} is missing`); return false; }
    let input: RunInput;
    let delivered: string[];
    let levelChanged = false;
    let carrying: string[];
    let carried: Set<string>;
    let interruption: boolean;
    try {
      if (this.runner.approvalLevel) {
        const refreshed = this.safe("approvalLevel", () => this.runner.approvalLevel!(n));
        if (!refreshed) return false; // A failed authority check starts nothing.
        levelChanged = n.level !== refreshed.level || n.levelSource !== refreshed.source;
        n.level = refreshed.level; n.levelSource = refreshed.source;
      }
      const children = this.store.children(n.id);
      const settled = awaited(children).filter(isTerminal);
      const ids = new Set(children.map(c => c.id));
      const inbox = this.store.inbox({ threadId: n.assignee.destination.threadId }, true).filter(i => ids.has(i.assignmentId));
      const fresh = new Set(inbox.filter(i => i.kind === "needs_input").map(i => i.assignmentId));
      const again = new Set(n.restart === "rerun" ? n.carrying : undefined);
      const asked = awaited(children).filter(c => asking(c) && (fresh.has(c.id) || again.has(c.id)));
      interruption = resumed && n.restart !== "rerun" && asked.length > 0;
      const names = this.names(n, parent);
      const turn: RunInput["turn"] = resumed ? "resume" : n.restart === "rerun" ? "rerun" : n.answer !== undefined ? "answered"
        : n.continuation ? "continued" : "first";
      input = {
        turn,
        resumed: turn !== "first",
        restartNote: interruption ? "" : restartNote(n, children, child => this.names(child, n).assignee),
        envelope: composeEnvelope(n, names, parent),
        ...(n.answer !== undefined ? { answer: n.answer } : {}),
        ...(n.continuation ? { continuation: { note: n.continuation.note, ...(n.continuation.handoffPath ? { handoffPath: n.continuation.handoffPath } : {}) } } : {}),
        ...(settled.length ? { settled } : {}),
        ...(asked.length ? { asked } : {}),
        level: n.level, mode: n.mode,
      };
      delivered = inbox.map(i => i.id);
      carrying = asked.map(c => c.id);
      carried = new Set(settled.map(c => c.id));
    } catch (error) {
      this.log(`dispatch(${n.id}) could not compose the turn: ${String(error)}`);
      return false;
    }
    n.status = "running"; n.startedAt = now; n.executions += 1; n.lastActivityAt = now;
    delete n.continuation; delete n.cards;
    if (carrying.length) n.carrying = carrying; else delete n.carrying;
    if (root.id !== n.id) root.lastActivityAt = now;
    if (root.budgets) root.budgets.executions += 1;
    try {
      this.store.transaction(() => {
        if (levelChanged) this.store.update(n, { kind: "level_changed", at: now, detail: `dispatch level ${n.level} (${n.levelSource})` });
        this.store.update(n, { kind: "admitted", at: now, detail: "admitted" });
        this.store.update(n, { kind: "started", at: now, detail: `running: turn ${n.executions}${resumed ? " (resume)" : ""}, level ${n.level}` });
        if (root.id !== n.id) this.store.update(root);
        this.store.markDelivered(delivered, now);
      });
    } catch (error) {
      this.log(`dispatch(${n.id}) not written, nothing started: ${String(error)}`);
      return false;
    }
    this.admissionNoted.delete(n.id);
    this.touch(n, root);
    const controller = new AbortController();
    const live: LiveTurn = { controller, rootId: root.id, activeAt: this.clock.monotonic(), interruption, carried };
    this.turns.set(n.id, live);
    this.rootActivity.set(root.id, now);
    let turn: Promise<RunResult>;
    try {
      turn = Promise.resolve(this.runner.run(n, input, controller.signal));
    } catch (error) {
      turn = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void turn.then(
      result => this.turnEnded(n.id, live, result),
      error => {
        this.log(`run(${n.id}) threw: ${String(error)}`);
        this.turnEnded(n.id, live, { kind: "failed", outcome: "provider_error", text: clip(String(error), 1000) });
      },
    ).finally(() => { if (this.turns.get(n.id) === live) this.turns.delete(n.id); });
    return true;
  }

  private turnEnded(id: string, live: LiveTurn, result: RunResult): void {
    try {
      if (this.turns.get(id) !== live) return;
      const n = this.store.get(id);
      if (!n || n.status !== "running") return;
      if (this.closing && result.kind === "failed") return;
      this.withBatch(() => this.finishTurn(n, result, live));
    } catch (error) {
      this.log(`settling ${id} failed: ${String(error)}`);
    }
  }

  /** `live`: the handle of the dispatched turn ending; a host turn begun with begin() has none. */
  private finishTurn(n: Assignment, result: RunResult, live?: LiveTurn): void {
    const now = this.clock.now();
    if (!live?.interruption) delete n.restart;
    delete n.answer; delete n.carrying;
    // Access is rechecked as the turn ends: a reply that lands after the route closed is never retained.
    const parentRow = n.parentId ? this.store.get(n.parentId) : undefined;
    const problem = this.safe("validate", () => this.runner.validate(n, parentRow));
    if (!this.lastThrew && problem) { this.settle(n, "failed", "refused", problem); return; }
    if (result.evidence) n.evidence = result.evidence;
    const root = n.parentId ? this.store.get(n.rootId) : n;
    if (result.kind === "continue") {
      n.result = clip(result.text, RESULT_MAX);
      n.guard = nextGuard(n.guard, result.evidence);
      const stop = loopStop(n.guard, result.text);
      if (stop) {
        this.store.update(n, { kind: "stalled", at: now, detail: `no progress: ${stop.reason}` });
        this.settle(n, "failed", "stalled", stop.detail);
        return;
      }
      n.status = "queued"; n.lastActivityAt = now;
      n.continuation = { note: result.note, ...(result.handoffPath ? { handoffPath: result.handoffPath } : {}), count: continuations(this.store, n.id) + 1 };
      if (root && root.id !== n.id) root.lastActivityAt = now;
      this.store.transaction(() => {
        this.store.update(n, { kind: "continued", at: now, detail: `queued: ${clip(result.note, DETAIL_MAX)}` });
        if (root && root.id !== n.id) this.store.update(root);
      });
      this.touch(n, ...root && root.id !== n.id ? [root] : []);
      return;
    }
    delete n.guard;
    if (result.kind === "needs_input") {
      n.status = "needs_input"; n.question = clip(result.question, BRIEF_MAX); n.lastActivityAt = now;
      if (result.cards?.length) n.cards = result.cards; else delete n.cards;
      this.store.update(n, { kind: "parked", at: now, detail: `needs_input: ${clip(result.question, DETAIL_MAX)}` });
      this.touch(n);
      this.safe("park", () => this.runner.park(n, n.question ?? ""));
      if (n.parentId && this.wake(n, "needs_input") && root && !isTerminal(root)) {
        this.cancelTree(root, `${this.limits.wakes} wakes without progress`, "failed", "budget");
      }
      return;
    }
    n.result = clip(result.text, RESULT_MAX);
    const kids = awaited(this.store.children(n.id));
    const unseen = live !== undefined && kids.some(c => isTerminal(c) && !live.carried.has(c.id));
    const outstanding = unseen || kids.some(c => !isTerminal(c)) || awaited(childrenSince(this.store, n)).length > 0;
    if (outstanding) {
      n.status = "waiting"; n.lastActivityAt = now;
      if (root) this.renew(root, now);
      this.store.transaction(() => {
        this.store.update(n, { kind: "waiting", at: now, detail: result.kind === "failed" ? `waiting: turn ${result.outcome}` : "waiting" });
        if (root && root.id !== n.id) this.store.update(root);
      });
      this.touch(n, ...root && root.id !== n.id ? [root] : []);
      return;
    }
    const ownTurn = !n.parentId;
    if (result.kind === "completed") this.settle(n, "completed", "done", undefined, ownTurn);
    else this.settle(n, "failed", result.outcome, undefined, ownTurn);
  }

  progress(id: string): void {
    const turn = this.turns.get(id);
    if (turn) {
      turn.activeAt = this.clock.monotonic();
      this.rootActivity.set(turn.rootId, this.clock.now());
      return;
    }
    const n = this.store.get(id);
    if (n?.status === "running") this.rootActivity.set(n.rootId, this.clock.now());
  }

  /** The person answered a parked question; the next turn carries it. */
  answer(id: string, text: string): boolean {
    const n = this.store.get(id);
    if (!n || n.status !== "needs_input") return false;
    const now = this.clock.now();
    n.answer = clip(text, BRIEF_MAX); delete n.question; n.status = "queued"; n.lastActivityAt = now;
    const root = n.parentId ? this.store.get(n.rootId) : undefined;
    this.store.transaction(() => {
      this.store.update(n, { kind: "answered", at: now, detail: "queued: answered" });
      if (root && !isTerminal(root)) { root.lastActivityAt = now; this.store.update(root); }
    });
    this.touch(n, ...root ? [root] : []);
    return true;
  }

  /** Cancel this node and everything under it; abort running turns. */
  cancel(id: string, reason = "Stopped by user", outcome: "stopped" | "failed" = "stopped"): void {
    const n = this.store.get(id);
    if (!n) return;
    this.withBatch(() => outcome === "failed" ? this.cancelTree(n, reason, "failed", "interrupted") : this.cancelTree(n, reason, "cancelled", "stopped"));
  }

  stopRequester(owner: Owner, reason = "Stopped by user"): Assignment[] {
    const left: Assignment[] = [];
    this.withBatch(() => {
      for (const snapshot of this.store.all({ nonTerminal: true })) {
        if (!ownsConversation(snapshot, owner)) continue;
        const n = this.store.get(snapshot.id);
        if (!n || isTerminal(n)) continue;
        for (const child of this.store.children(n.id)) {
          if (isTerminal(child)) continue;
          if (child.status === "queued" && (child.executions === 0 || child.restart === "rerun")) {
            this.cancelTree(child, child.restart === "rerun" ? "Stopped before it resumed" : "Stopped before it started", "cancelled", "stopped");
          } else left.push(child);
        }
        this.settle(n, "cancelled", "stopped", reason);
      }
    });
    return left;
  }

  status(id: string): StatusView | undefined {
    const assignment = this.store.get(id);
    if (!assignment) return undefined;
    const children = this.store.children(id);
    const about = new Set([id, ...children.map(c => c.id)]);
    const lanes = new Map([assignment, ...children].map(a => [JSON.stringify(wakeOwner(a)), wakeOwner(a)]));
    const inbox = new Map<string, InboxItem>();
    for (const lane of lanes.values()) {
      for (const item of this.store.inbox(lane)) if (about.has(item.assignmentId)) inbox.set(item.id, item);
    }
    return { assignment, children, inbox: [...inbox.values()].sort((a, b) => a.createdAt - b.createdAt) };
  }

  /** Non-terminal work this owner's nodes are waiting on. */
  outstanding(owner: Owner): Assignment[] {
    const live = this.store.all({ nonTerminal: true });
    if (owner.threadId === undefined && owner.runId !== undefined) return live.filter(n => ownsConversation(n, owner));
    const mine = new Set(live.filter(n => ownsConversation(n, owner)).map(n => n.id));
    return live.filter(n => n.parentId !== undefined && mine.has(n.parentId) && n.reply !== "none");
  }

  liveEdges(): LiveEdge[] {
    const edges: LiveEdge[] = [];
    for (const n of this.store.all({ nonTerminal: true })) {
      if (!n.parentId) continue;
      const parent = this.store.get(n.parentId);
      if (!parent || parent.assignee.botId === n.assignee.botId) continue;
      const state: LiveEdge["state"] = n.status === "resume" ? "waiting" : n.status as LiveEdge["state"];
      edges.push({ sourceBotId: parent.assignee.botId, targetBotId: n.assignee.botId, state, threadId: n.assignee.destination.threadId,
        ...(n.assignee.destination.groupId ? { groupId: n.assignee.destination.groupId } : {}) });
    }
    return edges;
  }

  /** Undelivered inbox items for this owner, marked delivered now. */
  poll(owner: Owner): { items: InboxItem[]; assignments: Assignment[] } {
    const now = this.clock.now();
    const items = this.store.inbox(owner, true);
    this.store.markDelivered(items.map(i => i.id), now);
    for (const item of items) item.deliveredAt = now;
    const assignments = items.flatMap(i => { const a = this.store.get(i.assignmentId); return a ? [a] : []; });
    return { items, assignments };
  }

  /** Shutdown began: dispatch nothing more; running turns are left for the
   * next open() to find cut. */
  close(): void {
    this.closing = true;
  }


  private cancelTree(n: Assignment, reason: string, status: "failed" | "cancelled", outcome: Outcome): void {
    for (const child of this.store.children(n.id)) {
      if (isTerminal(child)) continue;
      const fresh = this.store.get(child.id);
      if (fresh && !isTerminal(fresh)) this.cancelTree(fresh, reason, status, outcome);
    }
    const fresh = this.store.get(n.id);
    if (fresh && !isTerminal(fresh)) this.settle(fresh, status, outcome, reason);
  }

  private settle(n: Assignment, status: TerminalStatus, outcome: Outcome, detail?: string, ownTurn = false): void {
    if (isTerminal(n)) return;
    const now = this.clock.now();
    n.status = status; n.outcome = outcome; n.finishedAt = now; n.lastActivityAt = now;
    if (detail !== undefined) n.outcomeDetail = clip(detail, DETAIL_MAX); else delete n.outcomeDetail;
    if (status !== "completed" && detail !== undefined && n.result === "") n.result = clip(detail, RESULT_MAX);
    if (outcome === "refused" && detail !== undefined) { n.result = clip(detail, RESULT_MAX); delete n.evidence; }
    delete n.question; delete n.answer; delete n.restart; delete n.carrying;
    const kind: EventKind = status === "cancelled" ? "cancelled" : outcome === "refused" ? "refused" : "settled";
    const root = n.parentId ? this.store.get(n.rootId) : n;
    this.store.transaction(() => {
      this.store.update(n, { kind, at: now, detail: `${status}: ${outcome}${detail ? ` — ${clip(detail, DETAIL_MAX)}` : ""}` });
      if (root && root.id !== n.id && !isTerminal(root)) { this.renew(root, now); this.store.update(root); }
    });
    this.turns.get(n.id)?.controller.abort();
    this.turns.delete(n.id);
    this.admissionNoted.delete(n.id);
    if (root?.id === n.id) this.rootActivity.delete(n.id);
    this.touch(n, ...root && root.id !== n.id ? [root] : []);
    this.report(n, ownTurn);
  }

  private report(n: Assignment, ownTurn: boolean): void {
    if (n.reportedAt !== undefined) return;
    const now = this.clock.now();
    const parent = n.parentId ? this.store.get(n.parentId) : undefined;
    if (!ownTurn) {
      this.safe("report", () => this.runner.report(n, parent));
      if (this.lastThrew) { this.reportDue.add(n.id); return; }
    }
    n.reportedAt = now;
    this.store.update(n, { kind: "reported", at: now, detail: ownTurn ? "own turn" : "reported" });
    this.reportDue.delete(n.id);
    this.touch(n);
    if (n.parentId) this.wake(n, n.outcome === "stalled" ? "stalled" : "settled");
  }

  private wake(n: Assignment, kind: InboxKind): boolean {
    if (n.reply === "none") return false;
    const now = this.clock.now();
    const owner = wakeOwner(n);
    const item: InboxItem = { id: randomUUID(), assignmentId: n.id, kind, createdAt: now };
    if (owner.botId !== undefined) item.ownerBotId = owner.botId;
    if (owner.threadId !== undefined) item.ownerThreadId = owner.threadId;
    if (owner.runId !== undefined) item.ownerRunId = owner.runId;
    const root = n.parentId ? this.store.get(n.rootId) : n;
    let over = false;
    this.store.transaction(() => {
      this.store.addInbox(item);
      if (root?.budgets) {
        root.budgets.wakes += 1;
        over = root.budgets.wakes > this.limits.wakes;
        if (root.id !== n.id) this.store.update(root, over ? { kind: "budget", at: now, detail: `wakes: ${root.budgets.wakes}` } : undefined);
      }
      this.store.update(n, { kind: "woken", at: now, detail: kind });
      if (over && root?.id === n.id) this.store.update(n, { kind: "budget", at: now, detail: `wakes: ${n.budgets?.wakes ?? 0}` });
    });
    this.touch(n, ...root && root.id !== n.id ? [root] : []);
    return over;
  }


  private renew(root: Assignment, now: number): void {
    root.lastActivityAt = now;
    if (root.budgets) root.budgets = { since: now, requests: 0, executions: 0, wakes: 0 };
  }

  private since(at: number): number {
    return Math.max(at, this.bootAt);
  }

  /** Each needs_input inbox item resumes its waiting requester at most once: dispatch marks it delivered in the
   * same transaction that starts the turn, and a delivered item never counts again, across restarts too. */
  private resumeReason(n: Assignment): "settled" | "asked" | undefined {
    const kids = awaited(this.store.children(n.id));
    if (kids.length === 0) return undefined;
    if (kids.every(c => isTerminal(c) && c.reportedAt !== undefined)) return "settled";
    if (!n.parentId && n.reply === "poll") return undefined;
    const parked = new Set(kids.filter(asking).map(c => c.id));
    if (parked.size === 0) return undefined;
    const items = this.store.inbox({ threadId: n.assignee.destination.threadId }, true);
    return items.some(i => i.kind === "needs_input" && parked.has(i.assignmentId)) ? "asked" : undefined;
  }

  private inputExpires(n: Assignment): boolean {
    return Number.isFinite(this.limits.inputWaitMs) && !(n.cards && n.cards.length > 0);
  }

  private outwardOf(n: Assignment): string[] {
    const port = this.runner.outward;
    if (!port) return [];
    const labels = this.safe("outward", () => port.call(this.runner, n));
    return Array.isArray(labels) ? labels.filter(label => typeof label === "string" && label.trim() !== "") : [];
  }

  private names(n: Assignment, parent: Assignment | undefined): EnvelopeNames {
    const names = this.safe("names", () => this.runner.names(n, parent));
    return names ?? { requester: n.requester.botId ?? n.requester.kind, assignee: n.assignee.botId };
  }

  private safe<T>(what: string, fn: () => T): T | undefined {
    this.lastThrew = false;
    try {
      return fn();
    } catch (error) {
      this.lastThrew = true;
      this.log(`${what} threw: ${String(error)}`);
      return undefined;
    }
  }

  private withBatch<T>(fn: () => T): T {
    if (this.batch) return fn();
    this.batch = new Map();
    try {
      return fn();
    } finally {
      const rows = [...this.batch.values()];
      this.batch = null;
      if (rows.length) this.safe("changed", () => this.runner.changed(rows));
    }
  }

  private touch(...rows: Assignment[]): void {
    if (this.batch) { for (const row of rows) this.batch.set(row.id, row); return; }
    this.safe("changed", () => this.runner.changed(rows));
  }
}
