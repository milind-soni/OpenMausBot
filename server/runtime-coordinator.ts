import { join } from "node:path";

import type { BeginTurnRequest, Coordinator, CoordinatorHost, CoordinatorOptions, HandoffOptions, HandoffView, HostTurnResult, LiveHandoffEdge, RoomAddress } from "./coordinator.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import { composeEnvelope, composeReport, composeResume, composeRootTurn, continuationLine, envelopeNote } from "./runtime/envelope.ts";
import { Runtime } from "./runtime/runtime.ts";
import { importLegacyDelegations, importLegacyHandoffs, type LegacyThreadResolver } from "./runtime/import-legacy.ts";
import { openRuntimeStore, type RuntimeStore } from "./runtime/store.ts";
import { childrenSince, clip, isTerminal, path } from "./runtime/tree.ts";
import type { Assignment, EndResult, Origin, Owner, Reply, Requester, RunInput, RunResult, StatusView, TurnRunner } from "./runtime/types.ts";

const NOT_RUNNING = "The originating room task is no longer running";
const WRONG_SPEAKER = "The handoff belongs to a different room speaker";
const ANCESTOR = "Cannot assign work back to an ancestor; results return automatically";
const ALREADY_COMPLETED = "This agent already completed your assignment. Do not send acknowledgements or approvals as new work. Finish with your decision; results return automatically. Only use rework=true for concrete additional work.";
const ROOM_ANCESTOR = "A room request cannot return to an ancestor room; results are returned automatically";
const DEPTH = "Room handoff depth limit reached";
const BUDGET = "Room handoff budget exhausted";
const NO_TURN = "The requesting turn has no root (no turn)";

const BRIEF_MAX = 12_000;
const RUNTIME_DEPTH = /^Assignment depth limit reached/;
const NEEDS_INPUT = /^needs input:/i;

/** Per-turn stalls belong to the host's watchdog: this only keeps the runtime's window out of its way. */
const TURN_STALL_MS = 24 * 60 * 60_000;

const REQUESTS_PER_ROOT = 64;
const EXECUTIONS_PER_ROOT = 96;

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

const address = (a: Assignment): RoomAddress => {
  const { groupId, threadId } = a.assignee.destination;
  return { threadId, botId: a.assignee.botId, ...(groupId !== undefined ? { groupId } : {}) };
};

const sameSpeaker = (a: Assignment, source: RoomAddress): boolean =>
  a.assignee.destination.groupId === source.groupId && a.assignee.destination.threadId === source.threadId && a.assignee.botId === source.botId;

const ancestorOf = (ancestor: RoomAddress, target: RoomAddress): boolean =>
  ancestor.botId === target.botId && (!ancestor.groupId || !target.groupId || ancestor.groupId === target.groupId);

const kindOf = (groupId: string | undefined, parent: Assignment | undefined): HandoffView["kind"] =>
  groupId !== undefined && parent?.assignee.destination.groupId === groupId ? "assignment" : "work";

function legacyOrigin(origin: Origin): WorkOrigin | undefined {
  if (origin.kind !== "person") return { kind: "outside" };
  return origin.quote ? { kind: "user", request: origin.quote } : undefined;
}

const hostFirstTurn = (a: Assignment): boolean => !a.parentId && a.status === "running" && a.executions === 1;

function runtimeOrigin(origin: WorkOrigin | undefined, source: RoomAddress): Origin {
  return origin?.kind === "user"
    ? { kind: "person", source: "chat", ref: source.threadId, quote: origin.request }
    : { kind: "outside", source: "chat", ref: source.threadId };
}

export function needsInputQuestion(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last -= 1;
  if (last < 0) return undefined;
  const line = lines[last]!.trim();
  if (!NEEDS_INPUT.test(line)) return undefined;
  const question = [line.slice("NEEDS INPUT:".length), ...lines.slice(last + 1)].join("\n").trim();
  return question || undefined;
}

export function view(a: Assignment, parent?: Assignment): HandoffView {
  const groupId = a.assignee.destination.groupId;
  const status: HandoffView["status"] = hostFirstTurn(a) ? "source" : a.status === "needs_input" ? "waiting" : a.status;
  const node: HandoffView = {
    id: a.id, rootId: a.rootId, threadId: a.assignee.destination.threadId, botId: a.assignee.botId, key: a.assignee.botId,
    text: a.brief, createdAt: a.createdAt, status, result: a.result, reported: a.reportedAt !== undefined, executions: a.executions,
    lastProgressAt: a.lastActivityAt, approvalGranted: a.approved ?? false, kind: kindOf(groupId, parent), restarts: a.restarts,
    mode: a.mode, level: a.level, reply: a.reply, originKind: a.origin.kind,
  };
  if (a.outcome !== undefined) node.outcome = a.outcome;
  if (a.outcomeDetail !== undefined) node.outcomeDetail = a.outcomeDetail;
  if (a.question !== undefined) node.question = a.question;
  if (a.cards !== undefined) node.cards = a.cards;
  if (a.continuation !== undefined) node.continuation = { ...a.continuation };
  if (a.goalRunId !== undefined) node.goalRunId = a.goalRunId;
  if (a.parentId !== undefined) node.parentId = a.parentId;
  if (groupId !== undefined) node.groupId = groupId;
  if (a.batchKey !== undefined) node.requestBatchKey = a.batchKey;
  if (a.startedAt !== undefined) node.startedAt = a.startedAt;
  const origin = legacyOrigin(a.origin);
  if (origin) node.origin = origin;
  if (a.restart !== undefined) node.restart = a.restart;
  return node;
}

export class RuntimeCoordinator implements Coordinator {
  private readonly host: CoordinatorHost;
  private readonly store: RuntimeStore;
  private readonly runtime: Runtime;
  private readonly legacyFile: string | undefined;
  private readonly legacyDir: string | undefined;
  private readonly legacyThreads: LegacyThreadResolver | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private opened = false;
  private prunedAt: number | undefined;

  constructor(options: CoordinatorOptions) {
    this.host = options.host;
    this.legacyDir = options.dataDir === ":memory:" ? undefined : options.dataDir;
    this.legacyFile = this.legacyDir === undefined ? undefined : join(this.legacyDir, "room-handoffs.json");
    this.legacyThreads = options.legacyThreads;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error("coordinator:", line));
    this.store = openRuntimeStore(options.dataDir === ":memory:" ? ":memory:" : join(options.dataDir, "runtime.db"));
    this.runtime = new Runtime(this.store, this.runner(), {
      clock: { now: () => this.now(), monotonic: () => performance.now() },
      limits: { depth: 4, requests: REQUESTS_PER_ROOT, executions: EXECUTIONS_PER_ROOT, turnStallMs: TURN_STALL_MS, ...options.runtimeLimits },
      ...(options.log ? { log: options.log } : {}),
    });
  }

  /** Not at construction: reconciling calls the host, which is still initialising then. */
  private ready(): void {
    if (this.opened) return;
    this.opened = true;
    if (this.legacyFile) {
      try {
        const imported = importLegacyHandoffs(this.store, this.legacyFile, this.now());
        if (imported) this.log(`imported ${imported} room-handoff rows from ${this.legacyFile}`);
      } catch (error) {
        this.log(`room-handoffs.json not imported: ${String(error)}`);
      }
    }
    if (this.legacyDir) {
      try {
        const imported = importLegacyDelegations(this.store, this.legacyDir, this.now(),
          { log: this.log, ...(this.legacyThreads ? { threads: this.legacyThreads } : {}) });
        if (imported) this.log(`imported ${imported} delegation-ledger rows from ${this.legacyDir}`);
      } catch (error) {
        this.log(`delegations.json not imported: ${String(error)}`);
      }
    }
    this.runtime.open();
  }

  node(id: string): HandoffView | undefined {
    this.ready();
    const a = this.store.get(id);
    return a && this.project(a);
  }

  has(id: string): boolean {
    this.ready();
    return this.store.get(id) !== undefined;
  }

  all(): HandoffView[] {
    this.ready();
    const rows = this.store.all();
    const byId = new Map(rows.map(row => [row.id, row]));
    return rows.map(row => view(row, row.parentId ? byId.get(row.parentId) : undefined));
  }

  active(): HandoffView[] {
    this.ready();
    return this.live().map(row => this.project(row));
  }

  children(id: string): HandoffView[] {
    this.ready();
    const parent = this.store.get(id);
    return this.store.children(id).map(child => view(child, parent));
  }

  enqueue(source: RoomAddress, generation: string, parentId: string | undefined, target: RoomAddress, text: string,
    options: HandoffOptions = {}): { node: HandoffView; duplicate: boolean } {
    this.ready();
    const { approvalGranted = false, rework = false, requestBatchKey, thread } = options;
    const mode = options.mode ?? "work";
    const parent = parentId ? this.store.get(parentId) : this.store.get(generation);
    if (!parent) throw new Error(parentId ? NOT_RUNNING : NO_TURN);
    if (parent.status !== "running") throw new Error(NOT_RUNNING);
    if (!sameSpeaker(parent, source)) throw new Error(WRONG_SPEAKER);
    const brief = clip(text, BRIEF_MAX);
    const kind: HandoffView["kind"] = target.groupId !== undefined && target.groupId === source.groupId ? "assignment" : "work";
    const lineage = path(this.store, parent);
    const root = lineage[0]!;
    if (lineage.some(n => ancestorOf(address(n), target))) throw new Error(ANCESTOR);
    const siblings = this.store.children(parent.id);
    const existing = siblings.findLast(c => c.assignee.botId === target.botId && c.assignee.destination.groupId === target.groupId && c.brief === brief && c.mode === mode);
    if (existing && !(rework && isTerminal(existing))) return { node: view(existing, parent), duplicate: true };
    if (mode === "work" && !rework && siblings.some(c => c.mode === "work" && kindOf(c.assignee.destination.groupId, parent) === kind &&
      c.assignee.destination.groupId === target.groupId && c.assignee.botId === target.botId && c.status === "completed")) throw new Error(ALREADY_COMPLETED);
    if (kind === "work" && target.groupId && lineage.some(n => n.assignee.destination.groupId === target.groupId)) throw new Error(ROOM_ANCESTOR);
    const wanted: Reply = mode === "notify" ? "none" : options.reply ?? "resume";
    const reply: Reply = wanted === "none" ? "none" : root.reply === "poll" ? "poll" : wanted;
    const requester: Requester = { kind: "bot_turn", botId: parent.assignee.botId, threadId: parent.assignee.destination.threadId,
      chief: this.host.chiefOf(address(parent)), ...(parent.id === root.id && root.requester.runId !== undefined ? { runId: root.requester.runId } : {}) };
    const level = this.host.levelOf(target, address(parent), parent.origin.kind, mode);
    const result = this.runtime.enqueue({
      parentId: parent.id,
      origin: parent.origin,
      requester,
      assignee: { botId: target.botId, destination: { kind: target.groupId ? "room_thread" : thread === "standing" ? "standing_thread" : "work_thread",
        threadId: target.threadId, ...(target.groupId ? { groupId: target.groupId } : {}) } },
      mode, reply, brief: text, rework,
      ...(options.doneWhen ? { doneWhen: options.doneWhen } : {}),
      levels: { own: level.level },
      ...(level.driverKind !== undefined ? { driverKind: level.driverKind } : {}),
      approved: approvalGranted,
      ...(target.groupId && requestBatchKey ? { batchKey: requestBatchKey } : {}),
    });
    if (!result.ok) {
      if (result.outcome === "budget") throw new Error(BUDGET);
      throw new Error(RUNTIME_DEPTH.test(result.reason) ? DEPTH : result.reason);
    }
    return { node: view(result.assignment, parent), duplicate: result.duplicate };
  }

  status(id: string): StatusView | undefined {
    this.ready();
    return this.runtime.status(id);
  }

  job(threadId: string, since: number, botId?: string): { scopes: string[]; rows: Assignment[] } {
    this.ready();
    const given = new Map<string, Assignment>();
    for (const a of this.store.all({ ownerThreadId: threadId, roots: true, openSince: since })) {
      if (a.assignee.destination.threadId === threadId) given.set(a.id, a);
    }
    if (botId) for (const a of this.store.all({ assignee: { botId, threadId }, openSince: since })) given.set(a.id, a);
    const rows = new Map<string, Assignment>();
    const scopes: string[] = [];
    for (const start of [...given.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (rows.has(start.id)) continue;
      scopes.push(start.id);
      const subtree = start.parentId ? this.subtree(start) : this.store.all({ rootId: start.id });
      for (const a of subtree) rows.set(a.id, a);
    }
    return { scopes, rows: [...rows.values()].sort((a, b) => a.createdAt - b.createdAt) };
  }

  private subtree(start: Assignment): Assignment[] {
    const out = [start];
    const seen = new Set([start.id]);
    for (let i = 0; i < out.length; i++) {
      for (const child of this.store.children(out[i]!.id)) if (!seen.has(child.id)) { seen.add(child.id); out.push(child); }
    }
    return out;
  }

  poll(owner: Owner): { items: StatusView["inbox"]; assignments: HandoffView[] } {
    this.ready();
    const polled = this.runtime.poll(owner);
    return { items: polled.items, assignments: polled.assignments.map(a => this.project(a)) };
  }

  outstandingFor(threadId: string): HandoffView[] {
    this.ready();
    const live = this.live();
    const mine = new Set(live.filter(a => a.assignee.destination.threadId === threadId).map(a => a.id));
    return live.filter(a => a.parentId !== undefined && mine.has(a.parentId) && a.reply !== "none").map(a => this.project(a));
  }

  beginTurn(req: BeginTurnRequest): HandoffView {
    this.ready();
    const existing = this.store.get(req.id);
    if (existing) return this.project(existing);
    const { address, opener } = req;
    const row = this.runtime.begin({
      id: req.id,
      origin: opener?.origin ?? runtimeOrigin(req.origin, address),
      requester: opener
        ? { ...opener.requester, botId: opener.requester.botId ?? address.botId, threadId: opener.requester.threadId ?? address.threadId, chief: this.host.chiefOf(address) }
        : { kind: "person", threadId: address.threadId, botId: address.botId, chief: this.host.chiefOf(address) },
      assignee: { botId: address.botId, destination: { kind: address.groupId ? "room_thread" : "standing_thread", threadId: address.threadId,
        ...(address.groupId ? { groupId: address.groupId } : {}) } },
      brief: req.brief.slice(0, BRIEF_MAX),
      level: req.level,
      ...(opener?.requester.kind === "external_runtime" ? { reply: "poll" as const } : {}),
      ...(req.goalRunId ? { goalRunId: req.goalRunId } : {}),
    });
    return this.project(row);
  }

  endTurn(id: string, result: HostTurnResult): void {
    this.ready();
    const cards = result.cards && result.cards.ids.length > 0 ? result.cards : undefined;
    const end: EndResult = { ok: result.ok, text: result.text, ...(result.evidence ? { evidence: result.evidence } : {}),
      ...(cards ? { needsInput: { question: cards.question, cards: cards.ids } } : {}),
      ...(result.cap ? { continue: { note: result.cap.note, ...(result.cap.handoffPath ? { handoffPath: result.cap.handoffPath } : {}) } } : {}) };
    this.runtime.end(id, end);
  }

  answerNode(id: string, text: string): boolean {
    this.ready();
    const a = this.store.get(id);
    if (!a || a.status !== "needs_input") return false;
    return this.runtime.answer(id, text);
  }

  answerRoot(id: string, text: string): boolean {
    return this.answerNode(id, text);
  }

  parkedDirect(threadId: string): HandoffView | undefined {
    this.ready();
    const a = this.live().find(n => n.parentId === undefined && n.status === "needs_input" && this.direct(n, threadId));
    return a && this.project(a);
  }

  prune(before: number): number {
    this.ready();
    return this.runtime.prune(before);
  }

  sharedRequest(node: HandoffView): { id: string; botIds: string[] } {
    this.ready();
    const batch = node.groupId && node.requestBatchKey && node.parentId
      ? this.store.children(node.parentId).filter(c => c.batchKey === node.requestBatchKey && c.assignee.destination.groupId === node.groupId &&
        c.assignee.destination.threadId === node.threadId && c.brief === node.text)
      : [];
    if (batch.length === 0) return { id: node.id, botIds: [node.botId] };
    return { id: batch[0]!.id, botIds: batch.map(c => c.assignee.botId) };
  }

  cancelRoom(groupId: string, threadId?: string, reason = "Stopped by user", status: "failed" | "cancelled" = "cancelled"): void {
    this.ready();
    for (const n of this.live()) {
      if (n.assignee.destination.groupId !== groupId || (threadId && n.assignee.destination.threadId !== threadId)) continue;
      this.runtime.cancel(n.id, reason, status === "failed" ? "failed" : "stopped");
    }
  }

  cancelDirect(threadId: string, reason = "Stopped by user"): void {
    this.ready();
    for (const n of this.live()) if (this.direct(n, threadId)) this.runtime.cancel(n.id, reason, "stopped");
  }

  stopAwaitingDirect(threadId: string, reason = "Stopped by user"): HandoffView[] {
    this.ready();
    return this.runtime.stopRequester({ threadId }, reason).map(a => this.project(a));
  }

  activeDirect(threadId: string): boolean {
    this.ready();
    return this.live().some(n => this.direct(n, threadId));
  }

  assignerOf(threadId: string): HandoffView | undefined {
    this.ready();
    for (const n of this.live()) {
      if (!n.parentId || !this.direct(n, threadId)) continue;
      const parent = this.store.get(n.parentId);
      if (parent && !isTerminal(parent)) return this.project(parent);
    }
    return undefined;
  }

  outstandingDirect(threadId: string): HandoffView[] {
    this.ready();
    const out: HandoffView[] = [];
    for (const n of this.live()) {
      if (!n.parentId || n.reply === "none") continue;
      const parent = this.store.get(n.parentId);
      if (parent && !isTerminal(parent) && this.direct(parent, threadId)) out.push(view(n, parent));
    }
    return out;
  }

  liveEdges(): LiveHandoffEdge[] {
    this.ready();
    return this.runtime.liveEdges().map(edge => ({
      sourceBotId: edge.sourceBotId, targetBotId: edge.targetBotId, state: edge.state === "queued" ? "queued" : "running",
      threadId: edge.threadId, ...(edge.groupId !== undefined ? { groupId: edge.groupId } : {}),
    }));
  }

  continuesAfterRestart(threadId: string): boolean {
    this.ready();
    return this.live().some(n => n.assignee.destination.threadId === threadId && (
      (n.status === "running" && (n.restart !== "rerun" || childrenSince(this.store, n).length > 0)) ||
      ((n.status === "queued" || n.status === "resume") && n.restart === "rerun")));
  }

  note(id: string): string | undefined {
    this.ready();
    const a = this.store.get(id);
    if (!a) return undefined;
    const parent = a.parentId ? this.store.get(a.parentId) : undefined;
    return envelopeNote(composeEnvelope(a, this.host.names(this.project(a), parent && this.project(parent)), parent));
  }

  tick(): void {
    this.ready();
    this.pruneDaily();
    this.runtime.tick();
  }

  private pruneDaily(): void {
    const now = this.now();
    if (this.prunedAt !== undefined && now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    try {
      const removed = this.runtime.prune(now - PRUNE_AFTER_MS);
      if (removed > 0) this.log(`pruned ${removed} assignment rows of trees that finished more than 30 days ago`);
    } catch (error) {
      this.log(`prune failed: ${String(error)}`);
    }
  }

  close(): void {
    this.runtime.close();
  }

  progress(threadId: string): void {
    this.ready();
    for (const n of this.live()) if (n.status === "running" && n.assignee.destination.threadId === threadId) this.runtime.progress(n.id);
  }

  answer(threadId: string, text: string): boolean {
    this.ready();
    const parked = this.live().find(n => n.parentId !== undefined && n.status === "needs_input" && !(n.cards && n.cards.length > 0) &&
      n.assignee.destination.threadId === threadId);
    return parked ? this.runtime.answer(parked.id, text) : false;
  }

  awaitingAnswer(threadId: string): boolean {
    this.ready();
    return this.parkedIn(threadId) !== undefined;
  }

  private runner(): TurnRunner {
    const host = this.host;
    return {
      validate: (a, parent) => host.validate(view(a, parent), parent && this.project(parent)),
      canStart: a => !host.busy(this.project(a)),
      run: (a, input, signal) => this.run(a, input, signal),
      park: (a, question, restored) => host.park(this.project(a), question, restored),
      report: (a, parent) => host.report(view(a, parent), parent && this.project(parent)),
      changed: rows => {
        const groups = new Set<string>();
        const threads = new Set<string>();
        for (const row of rows) {
          const groupId = row.assignee.destination.groupId;
          if (groupId) groups.add(groupId); else threads.add(row.assignee.destination.threadId);
        }
        host.changed(groups, threads);
      },
      names: (a, parent) => host.names(view(a, parent), parent && this.project(parent)),
      outward: a => host.outward ? host.outward(this.project(a)) : [],
    };
  }

  private async run(a: Assignment, input: RunInput, signal: AbortSignal): Promise<RunResult> {
    const parent = a.parentId ? this.store.get(a.parentId) : undefined;
    const node = view(a, parent);
    const resumed = input.turn === "resume";
    const settled = input.settled ?? [];
    const root = a.parentId === undefined;
    const body = resumed
      ? composeResume(a, this.host.names(node, parent && this.project(parent)),
        settled.map(child => composeReport(this.readable(child, a, node), this.host.names(view(child, a), node))))
      : root
        ? composeRootTurn(a, { turn: input.turn === "resume" ? "first" : input.turn, restartNote: "", ...(input.answer !== undefined ? { answer: input.answer } : {}),
          ...(input.continuation ? { continuation: input.continuation } : {}) })
        : input.continuation ? `${continuationLine(input.continuation)}\n${input.envelope}` : input.envelope;
    const note = resumed || root ? body : envelopeNote(body);
    const evidence = (result: HostTurnResult) => result.evidence ? { evidence: result.evidence } : {};
    const result = await this.host.run(node, resumed, signal,
      { text: `${input.restartNote}${body}`, note: `${input.restartNote}${note}`, restartNote: input.restartNote, turn: input.turn });
    if (signal.aborted) return { kind: "failed", outcome: "stopped", text: result.text };
    if (result.cap) return { kind: "continue", text: result.text, note: result.cap.note, ...(result.cap.handoffPath ? { handoffPath: result.cap.handoffPath } : {}), ...evidence(result) };
    if (result.cards) return { kind: "needs_input", question: result.cards.question, cards: result.cards.ids, ...evidence(result) };
    if (!result.ok) return { kind: "failed", outcome: "provider_error", text: result.text, ...evidence(result) };
    const question = root ? undefined : needsInputQuestion(result.text);
    if (question !== undefined) return { kind: "needs_input", question, ...evidence(result) };
    return { kind: "completed", text: result.text, ...evidence(result) };
  }

  private live(): Assignment[] {
    return this.store.all({ nonTerminal: true });
  }

  private parkedIn(threadId: string): Assignment | undefined {
    return this.live().find(n => n.status === "needs_input" && n.assignee.destination.threadId === threadId);
  }

  private direct(a: Assignment, threadId: string): boolean {
    return a.assignee.destination.groupId === undefined && a.assignee.destination.threadId === threadId;
  }

  /** A route or membership that no longer admits the child withholds its words; only the reason travels. */
  private readable(child: Assignment, parent: Assignment, parentView: HandoffView): Assignment {
    const problem = this.host.validate(view(child, parent), parentView);
    if (!problem) return child;
    const { evidence: _evidence, ...rest } = child;
    return { ...rest, result: `Result withheld: ${problem}` };
  }

  private project(a: Assignment): HandoffView {
    return view(a, a.parentId ? this.store.get(a.parentId) : undefined);
  }
}
