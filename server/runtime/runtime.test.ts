import { describe, expect, it } from "vitest";

import { checkInvariants } from "./invariants.ts";
import { Runtime, type BeginRequest } from "./runtime.ts";
import { openRuntimeStore, type RuntimeStore } from "./store.ts";
import { CUT_TWICE, INTERRUPTED_OUTWARD, loopStop, nextGuard, outwardDetail } from "./tree.ts";
import type { Assignment, Clock, EnqueueRequest, Limits, RunInput, RunResult, TurnRunner } from "./types.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface FakeClock extends Clock { t: number; advance(ms: number): void }
const fakeClock = (start = 1_000_000): FakeClock => ({ t: start, now() { return this.t; }, monotonic() { return this.t; }, advance(ms) { this.t += ms; } });

type Script = (a: Assignment, input: RunInput) => RunResult | "hold" | undefined;

interface Fake extends TurnRunner {
  runs: Array<{ a: Assignment; input: RunInput; signal: AbortSignal }>;
  reports: Array<{ a: Assignment; parent?: Assignment }>;
  parks: Array<{ a: Assignment; question: string }>;
  changes: Assignment[][];
  held: Map<string, (result: RunResult) => void>;
  script: Script;
  canStartAnswer: true | false | string | (() => true | false | string);
  validateAnswer: string | undefined;
  reportThrows: number;
  release(id: string, result: RunResult): Promise<void>;
  live(): { running: Set<string>; parked: Set<string> };
}

function fakeRunner(script: Script = () => undefined): Fake {
  const fake: Fake = {
    runs: [], reports: [], parks: [], changes: [], held: new Map(), script, canStartAnswer: true, validateAnswer: undefined, reportThrows: 0,
    validate: () => fake.validateAnswer,
    canStart: () => typeof fake.canStartAnswer === "function" ? fake.canStartAnswer() : fake.canStartAnswer,
    run(a, input, signal) {
      fake.runs.push({ a, input, signal });
      const result = fake.script(a, input);
      if (result === "hold") return new Promise<RunResult>(resolve => fake.held.set(a.id, resolve));
      return Promise.resolve(result ?? { kind: "completed", text: `${a.assignee.botId} done` });
    },
    park: (a, question) => { fake.parks.push({ a, question }); },
    report(a, parent) {
      if (fake.reportThrows > 0) { fake.reportThrows -= 1; throw new Error("report failed"); }
      fake.reports.push({ a, ...(parent ? { parent } : {}) });
    },
    changed: rows => { fake.changes.push([...rows]); },
    names: a => ({ requester: a.requester.botId ?? "Milind", assignee: a.assignee.botId, person: "Milind" }),
    async release(id, result) {
      const resolve = fake.held.get(id);
      if (!resolve) throw new Error(`no held turn ${id}`);
      fake.held.delete(id);
      resolve(result);
      await flush();
    },
    live() {
      const running = new Set(fake.runs.filter(r => fake.held.has(r.a.id)).map(r => r.a.id));
      const parked = new Set(fake.parks.map(p => p.a.id));
      return { running, parked };
    },
  };
  return fake;
}

const chief = { botId: "chief", destination: { kind: "standing_thread" as const, threadId: "chief-chat" } };
const beginReq = (patch: Partial<BeginRequest> = {}): BeginRequest => ({
  origin: { kind: "person", source: "chat", quote: "Ship the CSV export" },
  requester: { kind: "person", threadId: "chief-chat", chief: true },
  assignee: chief, brief: "Ship the CSV export", level: "auto", ...patch,
});
const toBot = (botId: string, parentId: string, brief = `Build it, ${botId}`, patch: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
  parentId, origin: { kind: "person", source: "chat" },
  requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat", chief: true },
  assignee: { botId, destination: { kind: "work_thread", threadId: `${botId}-work` } },
  brief, levels: { own: "ask", chief: "auto" }, driverKind: "claudeAgent", ...patch,
});

interface World { store: RuntimeStore; runner: Fake; clock: FakeClock; runtime: Runtime; logs: string[]; limits: Partial<Limits> }
function world(script?: Script, limits: Partial<Limits> = {}, store = openRuntimeStore(":memory:"), ports: Pick<TurnRunner, "outward"> = {}): World {
  const runner = fakeRunner(script);
  if (ports.outward) runner.outward = ports.outward;
  const clock = fakeClock();
  const logs: string[] = [];
  const runtime = new Runtime(store, runner, { clock, limits, log: line => logs.push(line) });
  runtime.open();
  return { store, runner, clock, runtime, logs, limits };
}
const ok = (a: EnqueueResult): Assignment => { if (!a.ok) throw new Error(a.reason); return a.assignment; };
type EnqueueResult = ReturnType<Runtime["enqueue"]>;
const invariants = (w: World) => expect(checkInvariants(w.store, w.runner.live())).toEqual([]);

describe("Runtime: one tree, one lane", () => {
  it("runs a child, reports it once, then wakes the root with the settled children in one resume turn", async () => {
    const w = world();
    const root = w.runtime.begin(beginReq());
    expect(root.status).toBe("running");
    expect(root.executions).toBe(1);
    const child = ok(w.runtime.enqueue(toBot("builder", root.id)));
    expect(child).toMatchObject({ status: "queued", depth: 1, rootId: root.id, parentId: root.id, level: "auto", levelSource: "chief" });
    expect(w.runtime.liveEdges()).toEqual([{ sourceBotId: "chief", targetBotId: "builder", state: "queued", threadId: "builder-work" }]);
    w.runtime.tick();
    expect(w.runner.runs).toHaveLength(1);
    expect(w.runner.runs[0]!.input).toMatchObject({ resumed: false, restartNote: "", level: "auto", mode: "work" });
    expect(w.runner.runs[0]!.input.envelope).toContain(child.id);
    expect(w.store.get(child.id)?.status).toBe("running");
    await flush();
    expect(w.store.get(child.id)).toMatchObject({ status: "completed", outcome: "done", result: "builder done" });
    expect(w.runner.reports).toHaveLength(1);
    expect(w.runner.reports[0]).toMatchObject({ a: { id: child.id }, parent: { id: root.id } });
    const inbox = w.store.inbox({ botId: "chief", threadId: "chief-chat" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ assignmentId: child.id, kind: "settled" });
    expect(inbox[0]?.deliveredAt).toBeUndefined();
    expect(w.runtime.outstanding({ threadId: "chief-chat" })).toEqual([]);
    w.runtime.end(root.id, { ok: true, text: "Handed to builder" });
    expect(w.store.get(root.id)?.status).toBe("waiting");
    w.runtime.tick();
    expect(w.runner.runs).toHaveLength(2);
    const resume = w.runner.runs[1]!;
    expect(resume.a.id).toBe(root.id);
    expect(resume.input.resumed).toBe(true);
    expect(resume.input.settled?.map(s => s.id)).toEqual([child.id]);
    expect(w.store.inbox({ botId: "chief", threadId: "chief-chat" })[0]?.deliveredAt).toBe(w.clock.t);
    await flush();
    const done = w.store.get(root.id)!;
    expect(done).toMatchObject({ status: "completed", outcome: "done", result: "chief done", executions: 2 });
    expect(w.runner.reports).toHaveLength(1);
    expect(done.reportedAt).toBeDefined();
    expect(w.store.inbox({ threadId: "chief-chat" }).map(i => i.assignmentId)).toEqual([child.id]);
    expect(w.store.events(root.id).map(e => e.kind)).toEqual(["enqueued", "started", "waiting", "resume_due", "admitted", "started", "settled", "reported"]);
    invariants(w);
  });

  it("writes running before it runs, and a failed write starts nothing", async () => {
    const inner = openRuntimeStore(":memory:");
    let failOnce = true;
    const flaky: RuntimeStore = { ...inner, update(a, event) {
      if (event?.kind === "started" && a.parentId && failOnce) { failOnce = false; throw new Error("disk full"); }
      inner.update(a, event);
    } };
    const w = world(undefined, {}, flaky);
    const root = w.runtime.begin(beginReq());
    const child = ok(w.runtime.enqueue(toBot("builder", root.id)));
    w.runtime.tick();
    expect(w.runner.runs).toHaveLength(0);
    expect(w.logs.some(l => /not written, nothing started/.test(l))).toBe(true);
    const row = inner.get(child.id)!;
    expect(row).toMatchObject({ status: "queued", executions: 0 });
    expect(inner.events(child.id).map(e => e.kind)).toEqual(["enqueued"]);
    expect(inner.get(root.id)?.budgets?.executions).toBe(1);
    w.runtime.tick();
    expect(w.runner.runs).toHaveLength(1);
    expect(w.runner.runs[0]!.a.status).toBe("running");
    expect(inner.events(child.id).map(e => e.kind)).toEqual(["enqueued", "admitted", "started"]);
    await flush();
    invariants(w);
  });

  it("dedupes the same brief under one parent and runs it again only with rework", async () => {
    const w = world();
    const root = w.runtime.begin(beginReq());
    const first = ok(w.runtime.enqueue(toBot("builder", root.id)));
    const again = w.runtime.enqueue(toBot("builder", root.id));
    expect(again).toMatchObject({ ok: true, duplicate: true, assignment: { id: first.id } });
    expect(w.store.get(root.id)?.budgets?.requests).toBe(1);
    w.runtime.tick(); await flush();
    expect(w.store.get(first.id)?.status).toBe("completed");
    expect(w.runtime.enqueue(toBot("builder", root.id))).toMatchObject({ ok: true, duplicate: true, assignment: { id: first.id } });
    const rework = ok(w.runtime.enqueue(toBot("builder", root.id, undefined, { rework: true })));
    expect(rework.id).not.toBe(first.id);
    expect(rework.rework).toBe(true);
    const elsewhere = ok(w.runtime.enqueue(toBot("builder", root.id, undefined,
      { assignee: { botId: "builder", destination: { kind: "room_thread", threadId: "room-1", groupId: "g1" } } })));
    expect(elsewhere.id).not.toBe(rework.id);
    w.runtime.tick(); await flush();
    invariants(w);
  });

  it("refuses with typed reasons: a parent that is not running, an ancestor, depth, the request budget, the host", () => {
    const w = world(undefined, { depth: 2, requests: 3 });
    const root = w.runtime.begin(beginReq());
    expect(w.runtime.enqueue(toBot("builder", "nope"))).toMatchObject({ ok: false, outcome: "refused", reason: /no longer exists/ });
    expect(w.runtime.enqueue(toBot("chief", root.id))).toMatchObject({ ok: false, outcome: "refused", reason: /ancestor/ });
    const lead = ok(w.runtime.enqueue(toBot("lead", root.id)));
    expect(w.runtime.enqueue(toBot("builder", lead.id))).toMatchObject({ ok: false, outcome: "refused", reason: /not running/ });
    w.runtime.tick();
    expect(w.store.get(lead.id)?.status).toBe("running");
    const deep = ok(w.runtime.enqueue({ ...toBot("builder", lead.id), requester: { kind: "bot_turn", botId: "lead", threadId: "lead-work" } }));
    expect(deep.depth).toBe(2);
    expect(w.runtime.enqueue({ ...toBot("tester", deep.id), requester: { kind: "bot_turn", botId: "builder", threadId: "builder-work" } }))
      .toMatchObject({ ok: false, outcome: "refused", reason: /not running/ });
    w.runtime.tick();
    expect(w.runtime.enqueue({ ...toBot("tester", deep.id), requester: { kind: "bot_turn", botId: "builder", threadId: "builder-work" } }))
      .toMatchObject({ ok: false, outcome: "refused", reason: /depth/ });
    w.runner.validateAnswer = "No route to that bot";
    expect(w.runtime.enqueue(toBot("ops", root.id))).toMatchObject({ ok: false, outcome: "refused", reason: "No route to that bot" });
    w.runner.validateAnswer = undefined;
    expect(w.runtime.enqueue(toBot("reviewer", root.id)).ok).toBe(true);
    expect(w.runtime.enqueue(toBot("writer", root.id))).toMatchObject({ ok: false, outcome: "budget", reason: /Request budget/ });
    expect(w.store.events(root.id).some(e => e.kind === "budget")).toBe(true);
    expect(w.store.all()).toHaveLength(4);
  });

  it("renews the root's budgets on progress, and never refuses the owed resume turn", async () => {
    const w = world(undefined, { requests: 2, executions: 2 });
    const root = w.runtime.begin(beginReq());
    const a = ok(w.runtime.enqueue(toBot("a", root.id)));
    const b = ok(w.runtime.enqueue(toBot("b", root.id)));
    expect(w.runtime.enqueue(toBot("c", root.id))).toMatchObject({ ok: false, outcome: "budget" });
    w.runtime.tick();
    expect(w.store.get(a.id)?.status).toBe("running");
    expect(w.store.get(b.id)).toMatchObject({ status: "failed", outcome: "budget" });
    await flush();
    expect(w.store.get(root.id)?.budgets).toMatchObject({ requests: 0, executions: 0, wakes: 1 });
    expect(w.runtime.enqueue(toBot("c", root.id)).ok).toBe(true);
    w.runtime.end(root.id, { ok: true, text: "waiting" });
    w.runtime.tick(); await flush(); w.runtime.tick();
    expect(w.store.get(root.id)?.status).toBe("running");
    expect(w.runner.runs.at(-1)?.a.id).toBe(root.id);
    await flush();
    expect(w.store.get(root.id)?.status).toBe("completed");
    invariants(w);
  });

  it("expires a queue entry that never started and a question nobody answered, never as completed", async () => {
    const w = world(undefined, { queueMs: 1_000, inputWaitMs: 5_000 });
    const root = w.runtime.begin(beginReq());
    w.runner.canStartAnswer = "builder is busy on another thread";
    const stuck = ok(w.runtime.enqueue(toBot("builder", root.id)));
    w.runtime.tick(); w.runtime.tick();
    expect(w.store.events(stuck.id).filter(e => e.kind === "admitted")).toHaveLength(1);
    expect(w.store.events(stuck.id).at(-1)?.detail).toBe("waiting: builder is busy on another thread");
    w.clock.advance(1_001);
    w.runtime.tick();
    expect(w.store.get(stuck.id)).toMatchObject({ status: "failed", outcome: "expired", outcomeDetail: "never started" });
    expect(w.runner.reports.map(r => r.a.id)).toEqual([stuck.id]);
    w.runner.canStartAnswer = true;
    w.runner.script = () => ({ kind: "needs_input", question: "Which bucket?" });
    const asks = ok(w.runtime.enqueue(toBot("ops", root.id)));
    w.runtime.tick(); await flush();
    expect(w.store.get(asks.id)).toMatchObject({ status: "needs_input", question: "Which bucket?" });
    expect(w.runner.parks).toEqual([{ a: expect.objectContaining({ id: asks.id }), question: "Which bucket?" }]);
    expect(w.store.inbox({ threadId: "chief-chat" }).map(i => [i.assignmentId, i.kind])).toEqual([[stuck.id, "settled"], [asks.id, "needs_input"]]);
    w.clock.advance(4_999);
    w.runtime.tick();
    expect(w.store.get(asks.id)?.status).toBe("needs_input");
    w.clock.advance(2);
    w.runtime.tick();
    expect(w.store.get(asks.id)).toMatchObject({ status: "failed", outcome: "expired", outcomeDetail: "the person did not answer" });
    expect(w.runner.reports.map(r => r.a.id)).toEqual([stuck.id, asks.id]);
    w.runtime.end(root.id, { ok: true, text: "" });
    w.runtime.tick(); await flush();
    invariants(w);
  });

  it("answers a parked question into the next turn and delivers what settled meanwhile", async () => {
    const w = world();
    let helperId = "";
    w.runner.script = a => {
      if (a.assignee.botId !== "lead" || a.executions > 1) return undefined;
      helperId = ok(w.runtime.enqueue({ ...toBot("helper", a.id), requester: { kind: "bot_turn", botId: "lead", threadId: "lead-work" } })).id;
      return { kind: "needs_input", question: "Prod or staging?" };
    };
    const root = w.runtime.begin(beginReq());
    const lead = ok(w.runtime.enqueue(toBot("lead", root.id)));
    w.runtime.tick(); await flush();
    expect(w.store.get(lead.id)?.status).toBe("needs_input");
    expect(w.runtime.answer("nope", "x")).toBe(false);
    w.runtime.tick(); await flush();
    expect(w.store.get(helperId)?.status).toBe("completed");
    expect(w.store.get(lead.id)?.status).toBe("needs_input");
    expect(w.runtime.answer(lead.id, "Staging")).toBe(true);
    expect(w.store.get(lead.id)).toMatchObject({ status: "queued", answer: "Staging" });
    expect(w.store.get(lead.id)?.question).toBeUndefined();
    w.runtime.tick();
    const turn = w.runner.runs.find(r => r.a.id === lead.id && r.input.answer === "Staging")!;
    expect(turn.input.envelope).toContain("Staging");
    expect(turn.input.settled?.map(s => s.id)).toEqual([helperId]);
    expect(w.store.inbox({ botId: "lead", threadId: "lead-work" }).map(i => i.deliveredAt !== undefined)).toEqual([true]);
    await flush();
    expect(w.store.get(lead.id)).toMatchObject({ status: "completed", executions: 2 });
    expect(w.store.get(lead.id)?.answer).toBeUndefined();
    invariants(w);
  });

  it("stalls a turn with no activity on the monotonic clock, and a tree with no progress, but never a parked tree", async () => {
    const w = world(() => "hold", { turnStallMs: 1_000, stallMs: 10_000 });
    const root = w.runtime.begin(beginReq());
    const a = ok(w.runtime.enqueue(toBot("a", root.id)));
    w.runtime.tick();
    const signal = w.runner.runs[0]!.signal;
    w.clock.advance(900);
    w.runtime.progress(a.id);
    w.clock.advance(900);
    w.runtime.tick();
    expect(w.store.get(a.id)?.status).toBe("running");
    w.clock.advance(200);
    w.runtime.tick();
    expect(w.store.get(a.id)).toMatchObject({ status: "failed", outcome: "stalled" });
    expect(signal.aborted).toBe(true);
    expect(w.store.inbox({ threadId: "chief-chat" }).map(i => i.kind)).toEqual(["stalled"]);
    await w.runner.release(a.id, { kind: "completed", text: "too late" });
    expect(w.store.get(a.id)?.result).not.toBe("too late");
    w.runner.script = n => n.assignee.botId === "b" ? { kind: "needs_input", question: "?" } : undefined;
    const b = ok(w.runtime.enqueue(toBot("b", root.id)));
    w.runtime.tick(); await flush();
    w.runtime.end(root.id, { ok: true, text: "" });
    w.clock.advance(10_001);
    w.runtime.tick(); await flush();
    expect(w.store.get(root.id)?.status).toBe("waiting");
    expect(w.runner.runs.filter(r => r.a.id === root.id).map(r => r.input.asked?.map(c => c.id))).toEqual([[b.id]]);
    w.runtime.answer(b.id, "yes");
    w.runner.canStartAnswer = false;
    w.clock.advance(10_001);
    w.runtime.tick();
    expect(w.store.get(root.id)).toMatchObject({ status: "failed", outcome: "stalled" });
    expect(w.store.get(b.id)).toMatchObject({ status: "failed", outcome: "stalled" });
    expect(w.store.events(root.id).some(e => e.kind === "stalled")).toBe(true);
    expect(w.runner.reports.map(r => r.a.id)).toEqual([a.id, b.id, root.id]);
    invariants(w);
  });

  it("reconciles a restart from stored data: rerun once, cut after handing out work, re-park, fail a rerun cut again", async () => {
    const store = openRuntimeStore(":memory:");
    const first = world(() => "hold", {}, store);
    const root = first.runtime.begin(beginReq());
    const solo = ok(first.runtime.enqueue(toBot("solo", root.id)));
    const lead = ok(first.runtime.enqueue(toBot("lead", root.id)));
    const asker = ok(first.runtime.enqueue(toBot("asker", root.id)));
    first.runtime.tick();
    expect(first.runner.runs).toHaveLength(3);
    const helper = ok(first.runtime.enqueue({ ...toBot("helper", lead.id), requester: { kind: "bot_turn", botId: "lead", threadId: "lead-work" } }));
    await first.runner.release(asker.id, { kind: "needs_input", question: "Region?" });
    first.runtime.close();
    first.runtime.tick();
    await first.runner.release(lead.id, { kind: "failed", outcome: "provider_error", text: "killed" });
    expect(store.get(lead.id)?.status).toBe("running");

    const second = world(undefined, {}, store);
    expect(store.get(solo.id)).toMatchObject({ status: "queued", restart: "rerun", restarts: 1 });
    expect(store.get(lead.id)).toMatchObject({ status: "waiting", restart: "cut", restarts: 0 });
    expect(store.get(asker.id)?.status).toBe("needs_input");
    expect(second.runner.parks).toEqual([{ a: expect.objectContaining({ id: asker.id }), question: "Region?" }]);
    expect(store.get(root.id)).toMatchObject({ status: "waiting", restart: "cut", restarts: 0 });
    expect(store.get(helper.id)?.status).toBe("queued");
    expect(store.events(solo.id).at(-1)).toMatchObject({ kind: "restart_reconciled", detail: "queued: rerun 1" });
    expect(store.events(lead.id).at(-1)).toMatchObject({ kind: "restart_reconciled", detail: expect.stringMatching(/^waiting: cut/) });
    second.runtime.tick();
    const rerun = second.runner.runs.find(r => r.a.id === solo.id)!;
    expect(rerun.input.resumed).toBe(true);
    expect(rerun.input.restartNote).toMatch(/restarted while your previous turn/);
    await flush();
    expect(store.get(solo.id)?.status).toBe("completed");
    expect(store.get(solo.id)?.restart).toBeUndefined();
    second.runtime.tick(); await flush();
    expect(store.get(helper.id)?.status).toBe("completed");
    second.runtime.tick();
    const leadResume = second.runner.runs.find(r => r.a.id === lead.id)!;
    expect(leadResume.input.restartNote).toMatch(/restarted before your previous turn here finished/);
    expect(leadResume.input.settled?.map(s => s.id)).toEqual([helper.id]);
    await flush();
    second.runtime.answer(asker.id, "eu");
    second.runtime.tick(); await flush();
    second.runtime.tick();
    const [rootAsked, rootResume] = second.runner.runs.filter(r => r.a.id === root.id);
    expect(rootAsked!.input.asked?.map(s => s.id)).toEqual([asker.id]);
    expect(rootAsked!.input.restartNote).toBe("");
    expect(rootResume!.input.resumed).toBe(true);
    expect(rootResume!.input.asked).toBeUndefined();
    expect(rootResume!.input.settled?.map(s => s.id)).toEqual([solo.id, lead.id, asker.id]);
    expect(rootResume!.input.restartNote).toMatch(/restarted before your previous turn here finished.*A restart cut these teammates' turns: solo \(resumed once in place/);
    await flush();
    expect(store.get(root.id)?.status).toBe("completed");
    invariants(second);

    const third = world(() => "hold", {}, store);
    const root2 = third.runtime.begin(beginReq());
    const twice = ok(third.runtime.enqueue(toBot("twice", root2.id)));
    third.runtime.tick();
    third.runtime.close();
    const fourth = world(() => "hold", {}, store);
    expect(store.get(twice.id)).toMatchObject({ status: "queued", restarts: 1 });
    fourth.runtime.tick();
    fourth.runtime.close();
    const fifth = world(undefined, {}, store);
    expect(store.get(twice.id)).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 1, result: CUT_TWICE });
    expect(fifth.runner.reports.map(r => r.a.id)).toEqual([twice.id]);
    expect(store.get(root2.id)).toMatchObject({ status: "waiting", restart: "cut", restarts: 0 });
    fifth.runtime.tick();
    expect(fifth.runner.runs[0]!.input.restartNote).toMatch(/cut again while resuming/);
    await flush();
    expect(store.get(root2.id)?.status).toBe("completed");
    invariants(fifth);
    store.close();
  });

  it("cancels down the tree, aborts running turns and reports each stop", async () => {
    const w = world(() => "hold");
    const root = w.runtime.begin(beginReq());
    const lead = ok(w.runtime.enqueue(toBot("lead", root.id)));
    w.runtime.tick();
    const helper = ok(w.runtime.enqueue({ ...toBot("helper", lead.id), requester: { kind: "bot_turn", botId: "lead", threadId: "lead-work" } }));
    w.runtime.tick();
    const signals = w.runner.runs.map(r => r.signal);
    w.runtime.cancel(lead.id);
    expect(w.store.get(helper.id)).toMatchObject({ status: "cancelled", outcome: "stopped", outcomeDetail: "Stopped by user" });
    expect(w.store.get(lead.id)).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(signals.every(s => s.aborted)).toBe(true);
    expect(w.runner.reports.map(r => r.a.id)).toEqual([helper.id, lead.id]);
    expect(w.runtime.liveEdges()).toEqual([]);
    const other = ok(w.runtime.enqueue(toBot("other", root.id)));
    w.runtime.cancel(other.id, "Provider reloaded", "failed");
    expect(w.store.get(other.id)).toMatchObject({ status: "failed", outcome: "interrupted", outcomeDetail: "Provider reloaded" });
    w.runtime.cancel(root.id);
    expect(w.store.get(root.id)?.status).toBe("cancelled");
    expect(w.runner.reports.at(-1)?.a.id).toBe(root.id);
    invariants(w);
  });

  it("stops awaiting: queued work is dropped, a teammate mid-turn keeps its process and still reports", async () => {
    const w = world(() => "hold");
    const root = w.runtime.begin(beginReq());
    const running = ok(w.runtime.enqueue(toBot("running", root.id)));
    w.runtime.tick();
    w.runner.canStartAnswer = false;
    const queued = ok(w.runtime.enqueue(toBot("queued", root.id)));
    w.runtime.tick();
    const left = w.runtime.stopRequester({ threadId: "chief-chat" });
    expect(left.map(a => a.id)).toEqual([running.id]);
    expect(w.store.get(queued.id)).toMatchObject({ status: "cancelled", outcomeDetail: "Stopped before it started" });
    expect(w.store.get(root.id)).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(w.runner.runs[0]!.signal.aborted).toBe(false);
    await w.runner.release(running.id, { kind: "completed", text: "finished anyway" });
    expect(w.store.get(running.id)).toMatchObject({ status: "completed", result: "finished anyway" });
    expect(w.runner.reports.map(r => r.a.id)).toEqual([queued.id, root.id, running.id]);
    w.runtime.tick();
    expect(w.store.get(root.id)?.status).toBe("cancelled");
    expect(w.runner.runs).toHaveLength(1);
    expect(w.runtime.stopRequester({ threadId: "chief-chat" })).toEqual([]);
    invariants(w);
  });

  it("completes a poll root without a turn and hands its children's lane to poll()", async () => {
    const w = world();
    const ext = { kind: "external_runtime" as const, runId: "run-1" };
    const root = w.runtime.begin(beginReq({ requester: ext, origin: { kind: "outside", source: "external_runtime" }, reply: "poll" }));
    const a = ok(w.runtime.enqueue(toBot("a", root.id, "Do A", { requester: ext, reply: "poll" })));
    const b = ok(w.runtime.enqueue(toBot("b", root.id, "Do B", { requester: ext, reply: "poll" })));
    expect([a.origin.kind, b.level, b.levelSource]).toEqual(["outside", "ask", "own"]);
    expect(w.runtime.outstanding({ runId: "run-1" }).map(x => x.id)).toEqual([root.id]);
    w.runtime.end(root.id, { ok: true, text: "started two" });
    w.runtime.tick(); await flush(); w.runtime.tick();
    expect(w.store.get(root.id)).toMatchObject({ status: "completed", outcome: "done" });
    expect(w.runner.runs.map(r => r.a.id).sort()).toEqual([a.id, b.id].sort());
    expect(w.runner.reports.map(r => r.a.id)).toEqual([a.id, b.id, root.id]);
    expect(w.runtime.outstanding({ runId: "run-1" })).toEqual([]);
    const polled = w.runtime.poll({ runId: "run-1" });
    expect(polled.items.map(i => [i.assignmentId, i.kind])).toEqual([[a.id, "settled"], [b.id, "settled"]]);
    expect(polled.assignments.map(x => x.id)).toEqual([a.id, b.id]);
    expect(w.runtime.poll({ runId: "run-1" }).items).toEqual([]);
    expect(w.runtime.status(root.id)?.inbox.map(i => i.deliveredAt !== undefined)).toEqual([true, true]);
    invariants(w);
  });

  it("reads a host that throws as not now, and reports exactly once after a report that failed", async () => {
    const w = world();
    const root = w.runtime.begin(beginReq());
    const a = ok(w.runtime.enqueue(toBot("a", root.id)));
    w.runner.canStartAnswer = () => { throw new Error("slots unavailable"); };
    w.runtime.tick();
    expect(w.store.get(a.id)?.status).toBe("queued");
    expect(w.logs.some(l => /canStart threw/.test(l))).toBe(true);
    w.runner.canStartAnswer = true;
    w.runner.reportThrows = 1;
    w.runtime.tick(); await flush();
    expect(w.store.get(a.id)?.status).toBe("completed");
    expect(w.store.get(a.id)?.reportedAt).toBeUndefined();
    expect(w.store.inbox({ threadId: "chief-chat" })).toEqual([]);
    w.runtime.tick();
    expect(w.runner.reports.map(r => r.a.id)).toEqual([a.id]);
    expect(w.store.get(a.id)?.reportedAt).toBeDefined();
    expect(w.store.inbox({ threadId: "chief-chat" })).toHaveLength(1);
    w.runtime.tick();
    expect(w.runner.reports).toHaveLength(1);
    w.runner.script = () => { throw new Error("engine gone"); };
    const b = ok(w.runtime.enqueue(toBot("b", root.id)));
    w.runtime.tick(); await flush();
    expect(w.store.get(b.id)).toMatchObject({ status: "failed", outcome: "provider_error", result: "Error: engine gone" });
    w.runtime.end(root.id, { ok: true, text: "" });
    w.runner.script = () => undefined;
    w.runtime.tick(); await flush();
    invariants(w);
  });

  it("never overlaps turns in one conversation, waits on a running same-room speaker, and batches change notices per tick", async () => {
    const w = world(() => "hold");
    const root = w.runtime.begin(beginReq());
    const sameThread = { botId: "builder", destination: { kind: "work_thread" as const, threadId: "builder-work" } };
    const one = ok(w.runtime.enqueue(toBot("builder", root.id, "One", { assignee: sameThread })));
    const two = ok(w.runtime.enqueue(toBot("builder", root.id, "Two", { assignee: sameThread })));
    const notice = ok(w.runtime.enqueue(toBot("ops", root.id, "FYI", { mode: "notify" })));
    expect(notice.reply).toBe("none");
    const before = w.runner.changes.length;
    w.runtime.tick();
    expect(w.runner.changes.length - before).toBe(1);
    expect(w.runner.runs.map(r => r.a.id)).toEqual([one.id, notice.id]);
    await w.runner.release(one.id, { kind: "completed", text: "one" });
    w.runtime.tick();
    expect(w.runner.runs.map(r => r.a.id)).toEqual([one.id, notice.id, two.id]);
    await w.runner.release(two.id, { kind: "completed", text: "two" });
    w.runtime.end(root.id, { ok: true, text: "" });
    w.runtime.tick();
    expect(w.store.get(root.id)?.status).toBe("running");
    expect(w.runner.runs.at(-1)?.input.settled?.map(s => s.id)).toEqual([one.id, two.id]);
    await w.runner.release(root.id, { kind: "completed", text: "synth" });
    expect(w.store.get(root.id)?.status).toBe("completed");
    await w.runner.release(notice.id, { kind: "completed", text: "noted" });
    expect(w.store.inbox({ botId: "chief", threadId: "chief-chat" }).map(i => i.assignmentId)).toEqual([one.id, two.id]);
    invariants(w);
  });
});

describe("Runtime: host-named roots and request marks", () => {
  it("begins a root under the id the host names, or a fresh uuid", () => {
    const w = world();
    const named = w.runtime.begin(beginReq({ id: "gen-1" }));
    expect(named).toMatchObject({ id: "gen-1", rootId: "gen-1", status: "running" });
    expect(w.store.get("gen-1")?.id).toBe("gen-1");
    const fresh = w.runtime.begin(beginReq());
    expect(fresh.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.rootId).toBe(fresh.id);
  });

  it("copies approved and batchKey onto the row and keeps them through the store", async () => {
    const w = world();
    const root = w.runtime.begin(beginReq({ id: "gen-2" }));
    const marked = ok(w.runtime.enqueue(toBot("builder", root.id, undefined, { approved: true, batchKey: "batch-1" })));
    expect(marked).toMatchObject({ approved: true, batchKey: "batch-1" });
    expect(w.store.get(marked.id)).toMatchObject({ approved: true, batchKey: "batch-1" });
    const plain = ok(w.runtime.enqueue(toBot("tester", root.id)));
    expect(plain.approved).toBeUndefined();
    expect(plain.batchKey).toBeUndefined();
    expect("approved" in w.store.get(plain.id)!).toBe(false);
    w.runtime.tick(); await flush();
    expect(w.store.get(marked.id)).toMatchObject({ status: "completed", approved: true, batchKey: "batch-1" });
    invariants(w);
  });

  it("ends a root the host's watchdog stopped as stalled, any other failed root as a provider error", () => {
    const w = world();
    w.runtime.begin(beginReq({ id: "gen-3" }));
    w.runtime.end("gen-3", { ok: false, text: "No activity for 20 minutes — the turn was stopped.", stalled: true });
    expect(w.store.get("gen-3")).toMatchObject({ status: "failed", outcome: "stalled" });
    w.runtime.begin(beginReq({ id: "gen-4" }));
    w.runtime.end("gen-4", { ok: false, text: "The engine exited" });
    expect(w.store.get("gen-4")).toMatchObject({ status: "failed", outcome: "provider_error" });
    invariants(w);
  });
});

describe("access rechecked while work runs", () => {
  it("fails a running child whose route closes, drops its words, and the resume carries only the reason", async () => {
    const w = world(() => "hold");
    const root = w.runtime.begin(beginReq());
    const child = ok(w.runtime.enqueue(toBot("builder", root.id)));
    w.runtime.tick();
    expect(w.store.get(child.id)?.status).toBe("running");
    const signal = w.runner.runs[0]!.signal;
    w.runner.validate = a => a.id === child.id ? "Destination room setup is unfinished" : undefined;
    w.runtime.tick();
    expect(w.store.get(child.id)).toMatchObject({ status: "failed", outcome: "refused", result: "Destination room setup is unfinished" });
    expect(signal.aborted).toBe(true);
    await w.runner.release(child.id, { kind: "completed", text: "PRIVATE_RESULT" });
    expect(w.store.get(child.id)?.result).not.toContain("PRIVATE");
    w.runtime.end(root.id, { ok: true, text: "handed out" });
    w.runtime.tick();
    const resume = w.runner.runs.find(r => r.a.id === root.id && r.input.resumed);
    expect(resume?.input.settled?.map(s => s.result)).toEqual(["Destination room setup is unfinished"]);
    invariants(w);
  });

  it("drops a reply that lands after the route closed, before any tick could notice", async () => {
    const w = world(() => "hold");
    const root = w.runtime.begin(beginReq());
    const child = ok(w.runtime.enqueue(toBot("builder", root.id)));
    w.runtime.tick();
    w.runner.validate = a => a.id === child.id ? "The recipient is not an allowed peer of the sender" : undefined;
    await w.runner.release(child.id, { kind: "completed", text: "PRIVATE_RESULT" });
    expect(w.store.get(child.id)).toMatchObject({ status: "failed", outcome: "refused", result: "The recipient is not an allowed peer of the sender" });
    expect(w.runner.reports.map(r => r.a.id)).toEqual([child.id]);
    invariants(w);
  });
});

describe("a resume turn a restart cut", () => {
  it("runs again with the same settled results, as a rerun, not as a fresh resume", async () => {
    const store = openRuntimeStore(":memory:");
    const first = world(() => "hold", {}, store);
    const root = first.runtime.begin(beginReq());
    const child = ok(first.runtime.enqueue(toBot("builder", root.id)));
    first.runtime.tick();
    await first.runner.release(child.id, { kind: "completed", text: "built" });
    first.runtime.end(root.id, { ok: true, text: "handed out" });
    first.runtime.tick();
    const resume = first.runner.runs.find(r => r.a.id === root.id)!;
    expect(resume.input.turn).toBe("resume");
    expect(resume.input.settled?.map(s => s.id)).toEqual([child.id]);
    first.runtime.close();
    const second = world(() => "hold", {}, store);
    expect(store.get(root.id)).toMatchObject({ status: "resume", restart: "rerun", restarts: 1 });
    second.runtime.tick();
    const rerun = second.runner.runs.find(r => r.a.id === root.id)!;
    expect(rerun.input.turn).toBe("resume");
    expect(rerun.input.settled?.map(s => s.id)).toEqual([child.id]);
    expect(rerun.input.restartNote).toContain("this turn continues it");
    await second.runner.release(root.id, { kind: "completed", text: "reviewed" });
    expect(store.get(root.id)).toMatchObject({ status: "completed", executions: 3 });
    invariants(second);
  });
});

describe("Runtime: what the host relies on for the new modes and openers", () => {
  it("status(root) carries its children's inbox items in the resume lane too; status(child) shows its own", async () => {
    const w = world();
    const root = w.runtime.begin(beginReq());
    const a = ok(w.runtime.enqueue(toBot("a", root.id)));
    const b = ok(w.runtime.enqueue(toBot("b", root.id)));
    w.runtime.tick(); await flush();
    expect(w.runtime.status(root.id)?.inbox.map(i => [i.assignmentId, i.kind, i.deliveredAt])).toEqual([[a.id, "settled", undefined], [b.id, "settled", undefined]]);
    expect(w.runtime.status(root.id)?.children.map(c => c.id)).toEqual([a.id, b.id]);
    expect(w.runtime.status(a.id)).toMatchObject({ assignment: { id: a.id, status: "completed" }, children: [], inbox: [expect.objectContaining({ assignmentId: a.id })] });
    expect(w.runtime.status("nope")).toBeUndefined();
    w.runtime.end(root.id, { ok: true, text: "" });
    w.runtime.tick(); await flush();
    invariants(w);
  });

  it("poll and stopRequester work by run id alone, for a root whose requester has nothing else", async () => {
    const w = world(() => "hold");
    const ext = { kind: "external_runtime" as const, runId: "run-9" };
    const root = w.runtime.begin(beginReq({ requester: ext, origin: { kind: "outside", source: "external_runtime" }, reply: "poll" }));
    const a = ok(w.runtime.enqueue(toBot("a", root.id, "Do A", { requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat", runId: "run-9" }, reply: "poll" })));
    const b = ok(w.runtime.enqueue(toBot("b", root.id, "Do B", { requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat", runId: "run-9" }, reply: "poll" })));
    w.runner.canStartAnswer = () => w.runner.runs.length === 0;
    w.runtime.tick();
    expect(w.runner.runs.map(r => r.a.id)).toEqual([a.id]);
    await w.runner.release(a.id, { kind: "completed", text: "A done" });
    expect(w.runtime.poll({ runId: "run-9" }).items.map(i => i.assignmentId)).toEqual([a.id]);
    expect(w.runtime.poll({ runId: "run-9" }).items).toEqual([]);
    expect(w.store.inbox({ threadId: "chief-chat" }).map(i => i.assignmentId)).toEqual([a.id]);
    expect(w.runtime.outstanding({ runId: "run-9" }).map(x => x.id)).toEqual([root.id]);
    expect(w.runtime.stopRequester({ runId: "run-9" })).toEqual([]);
    expect(w.store.get(b.id)).toMatchObject({ status: "cancelled", outcomeDetail: "Stopped before it started" });
    expect(w.store.get(root.id)).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(w.runtime.outstanding({ runId: "run-9" })).toEqual([]);
    invariants(w);
  });

  it("a notify child never holds its parent: waiting → resume → completed while the notice still runs, and it writes no inbox item", async () => {
    const w = world(a => a.mode === "notify" ? "hold" : undefined);
    const root = w.runtime.begin(beginReq());
    w.runner.canStartAnswer = false;
    const work = ok(w.runtime.enqueue(toBot("builder", root.id)));
    const notice = ok(w.runtime.enqueue(toBot("ops", root.id, "FYI", { mode: "notify" })));
    expect(notice).toMatchObject({ mode: "notify", reply: "none" });
    expect(w.runtime.outstanding({ threadId: "chief-chat" }).map(x => x.id)).toEqual([work.id]);
    w.runtime.end(root.id, { ok: true, text: "handed out" });
    expect(w.store.get(root.id)?.status).toBe("waiting");
    w.runner.canStartAnswer = true;
    w.runtime.tick(); await flush();
    expect(w.store.get(work.id)?.status).toBe("completed");
    expect(w.store.get(notice.id)?.status).toBe("running");
    w.runtime.tick();
    expect(w.store.get(root.id)).toMatchObject({ status: "running", executions: 2 });
    expect(w.runner.runs.at(-1)?.input.settled?.map(s => s.id)).toEqual([work.id]);
    await flush();
    expect(w.store.get(root.id)?.status).toBe("completed");
    await w.runner.release(notice.id, { kind: "completed", text: "noted" });
    expect(w.store.get(notice.id)).toMatchObject({ status: "completed", reportedAt: expect.any(Number) });
    expect(w.store.inbox({ threadId: "chief-chat" }).map(i => i.assignmentId)).toEqual([work.id]);
    expect(w.store.events(notice.id).some(e => e.kind === "woken")).toBe(false);
    invariants(w);
  });

  it("an external poll root whose only children are notices completes at end()", async () => {
    const w = world(() => "hold");
    const ext = { kind: "external_runtime" as const, runId: "run-3" };
    const root = w.runtime.begin(beginReq({ requester: ext, origin: { kind: "outside", source: "external_runtime" }, reply: "poll" }));
    const notice = ok(w.runtime.enqueue(toBot("ops", root.id, "FYI", { mode: "notify", requester: { kind: "bot_turn", botId: "chief", threadId: "chief-chat", runId: "run-3" } })));
    expect(notice.reply).toBe("none");
    w.runtime.end(root.id, { ok: true, text: "sent a notice" });
    expect(w.store.get(root.id)).toMatchObject({ status: "completed", outcome: "done", reportedAt: expect.any(Number) });
    expect(w.runtime.outstanding({ runId: "run-3" })).toEqual([]);
    w.runtime.tick();
    expect(w.store.get(notice.id)?.status).toBe("running");
    await w.runner.release(notice.id, { kind: "completed", text: "noted" });
    expect(w.runtime.poll({ runId: "run-3" }).items).toEqual([]);
    invariants(w);
  });

  it("the same words as work and as a consultation are two requests", async () => {
    const w = world();
    const root = w.runtime.begin(beginReq());
    const work = ok(w.runtime.enqueue(toBot("builder", root.id, "Is the export done?")));
    const consult = ok(w.runtime.enqueue(toBot("builder", root.id, "Is the export done?", { mode: "consult" })));
    expect(consult.id).not.toBe(work.id);
    expect(consult).toMatchObject({ mode: "consult", reply: "resume" });
    expect(w.runtime.enqueue(toBot("builder", root.id, "Is the export done?", { mode: "consult" }))).toMatchObject({ ok: true, duplicate: true, assignment: { id: consult.id } });
    w.runtime.tick(); await flush(); w.runtime.tick(); await flush();
    w.runtime.end(root.id, { ok: true, text: "" });
    w.runtime.tick(); await flush();
    invariants(w);
  });
});

describe("Runtime: a root's later executions (every turn a root)", () => {
  const cards = { question: "Connect GitHub", cards: ["msg-1", "msg-2"] };

  it("end() with needsInput parks the root with its cards through the store; answer() queues the answered turn; dispatch clears the cards", async () => {
    const w = world();
    const root = w.runtime.begin(beginReq());
    w.runtime.end(root.id, { ok: true, text: "Connect it.", needsInput: cards });
    expect(w.store.get(root.id)).toMatchObject({ status: "needs_input", question: "Connect GitHub", cards: ["msg-1", "msg-2"], executions: 1 });
    expect(w.runner.parks).toEqual([{ a: expect.objectContaining({ id: root.id, cards: ["msg-1", "msg-2"] }), question: "Connect GitHub" }]);
    expect(w.store.inbox({ threadId: "chief-chat" })).toEqual([]);
    w.runtime.tick();
    expect(w.runner.runs).toHaveLength(0);
    expect(w.runtime.answer(root.id, "The user connected GitHub.")).toBe(true);
    expect(w.store.get(root.id)).toMatchObject({ status: "queued", answer: "The user connected GitHub.", cards: ["msg-1", "msg-2"] });
    expect(w.store.get(root.id)?.question).toBeUndefined();
    w.runtime.tick();
    expect(w.runner.runs).toHaveLength(1);
    expect(w.runner.runs[0]!.input).toMatchObject({ turn: "answered", resumed: true, restartNote: "", answer: "The user connected GitHub.", level: "auto", mode: "work" });
    expect(w.runner.runs[0]!.a.cards).toBeUndefined();
    expect(w.store.get(root.id)?.cards).toBeUndefined();
    await flush();
    expect(w.store.get(root.id)).toMatchObject({ status: "completed", result: "chief done", executions: 2 });
    expect(w.runner.reports).toEqual([]);
    expect(w.store.events(root.id).map(e => e.kind)).toEqual(["enqueued", "started", "parked", "answered", "admitted", "started", "settled", "reported"]);
    invariants(w);
  });

  it("end() with continue queues the continued turn; the count survives the dispatch that consumed the continuation and the budget is not renewed", async () => {
    const w = world((_a, input) => input.turn === "continued" && input.continuation?.note === "Cap 1."
      ? { kind: "continue", text: "second half", note: "Cap 2.", handoffPath: "/h/2.md" } : undefined, { executions: 10 });
    const root = w.runtime.begin(beginReq());
    expect(w.store.get(root.id)?.budgets?.executions).toBe(1);
    w.runtime.end(root.id, { ok: true, text: "first half", continue: { note: "Cap 1.", handoffPath: "/h/1.md" }, evidence: { commands: 2 } });
    expect(w.store.get(root.id)).toMatchObject({ status: "queued", result: "first half", evidence: { commands: 2 },
      continuation: { note: "Cap 1.", handoffPath: "/h/1.md", count: 1 }, budgets: { executions: 1 } });
    w.runtime.tick();
    expect(w.runner.runs[0]!.input).toMatchObject({ turn: "continued", resumed: true, continuation: { note: "Cap 1.", handoffPath: "/h/1.md" } });
    expect(w.runner.runs[0]!.a.continuation).toBeUndefined();
    expect(w.store.get(root.id)?.budgets?.executions).toBe(2);
    await flush();
    expect(w.store.get(root.id)).toMatchObject({ status: "queued", result: "second half", continuation: { note: "Cap 2.", handoffPath: "/h/2.md", count: 2 }, budgets: { executions: 2 } });
    w.runtime.tick();
    expect(w.runner.runs[1]!.input).toMatchObject({ turn: "continued", continuation: { note: "Cap 2.", handoffPath: "/h/2.md" } });
    await flush();
    expect(w.store.get(root.id)).toMatchObject({ status: "completed", executions: 3, budgets: { executions: 3 } });
    expect(w.store.events(root.id).filter(e => e.kind === "continued").map(e => e.detail)).toEqual(["queued: Cap 1.", "queued: Cap 2."]);
    invariants(w);
  });

  it("a host that ends a runtime-dispatched root turn through end() is heard once: the run() result that follows is ignored and never settles the next execution", async () => {
    const w = world(() => "hold");
    const root = w.runtime.begin(beginReq());
    w.runtime.end(root.id, { ok: true, text: "", needsInput: cards });
    w.runtime.answer(root.id, "connected");
    w.runtime.tick();
    expect(w.runner.held.has(root.id)).toBe(true);
    const first = w.runner.runs[0]!;
    w.runtime.end(root.id, { ok: true, text: "half", continue: { note: "Cap." } });
    expect(first.signal.aborted).toBe(false);
    expect(w.store.get(root.id)).toMatchObject({ status: "queued", executions: 2, continuation: { note: "Cap.", count: 1 } });
    const staleResolve = w.runner.held.get(root.id)!;
    w.runtime.tick();
    expect(w.runner.runs).toHaveLength(2);
    expect(w.store.get(root.id)).toMatchObject({ status: "running", executions: 3 });
    const second = w.runner.runs[1]!;
    staleResolve({ kind: "completed", text: "stale" });
    await flush();
    expect(w.store.get(root.id)).toMatchObject({ status: "running", executions: 3 });
    expect(second.signal.aborted).toBe(false);
    await w.runner.release(root.id, { kind: "completed", text: "fresh" });
    expect(w.store.get(root.id)).toMatchObject({ status: "completed", result: "fresh", executions: 3 });
    invariants(w);
  });

  it("end() is for roots only and never throws: a child, an unknown id and a settled root are logged and left as they are", async () => {
    const w = world(() => "hold");
    const root = w.runtime.begin(beginReq());
    const child = ok(w.runtime.enqueue(toBot("builder", root.id)));
    w.runtime.tick();
    expect(w.store.get(child.id)?.status).toBe("running");
    expect(() => w.runtime.end(child.id, { ok: true, text: "done" })).not.toThrow();
    expect(w.store.get(child.id)?.status).toBe("running");
    expect(() => w.runtime.end("ghost", { ok: true, text: "" })).not.toThrow();
    w.runtime.end(root.id, { ok: true, text: "" });
    expect(w.store.get(root.id)?.status).toBe("waiting");
    expect(() => w.runtime.end(root.id, { ok: false, text: "twice" })).not.toThrow();
    expect(w.store.get(root.id)).toMatchObject({ status: "waiting", result: "" });
    expect(w.logs.filter(line => /not a running root/.test(line))).toHaveLength(3);
    invariants(w);
  });

  it("a root parked on cards never expires; a child's question does; a non-finite inputWaitMs never expires anything", async () => {
    const w = world((a) => a.assignee.botId === "builder" ? { kind: "needs_input", question: "Region?" } : undefined, { inputWaitMs: 1_000 });
    const root = w.runtime.begin(beginReq());
    const child = ok(w.runtime.enqueue(toBot("builder", root.id)));
    w.runtime.tick(); await flush();
    w.runtime.end(root.id, { ok: true, text: "", needsInput: cards });
    expect(w.store.get(child.id)?.status).toBe("needs_input");
    w.clock.advance(30 * 24 * 60 * 60_000);
    w.runtime.tick();
    expect(w.store.get(child.id)).toMatchObject({ status: "failed", outcome: "expired" });
    expect(w.store.get(root.id)).toMatchObject({ status: "needs_input", cards: ["msg-1", "msg-2"] });
    invariants(w);

    const v = world((a) => a.assignee.botId === "builder" ? { kind: "needs_input", question: "Region?" } : undefined, { inputWaitMs: Number.POSITIVE_INFINITY });
    const root2 = v.runtime.begin(beginReq());
    const child2 = ok(v.runtime.enqueue(toBot("builder", root2.id)));
    v.runtime.tick(); await flush();
    v.runtime.end(root2.id, { ok: true, text: "" });
    v.clock.advance(400 * 24 * 60 * 60_000);
    v.runtime.tick(); await flush();
    expect(v.store.get(child2.id)?.status).toBe("needs_input");
    expect(v.store.get(root2.id)?.status).toBe("waiting");
    invariants(v);
  });

  it("open() re-parks a root on its cards without a new item, and reruns a cut root once before failing it interrupted", async () => {
    const store = openRuntimeStore(":memory:");
    const first = world(undefined, {}, store);
    const parked = first.runtime.begin(beginReq({ id: "root-parked" }));
    first.runtime.end(parked.id, { ok: true, text: "", needsInput: cards });
    const cut = first.runtime.begin(beginReq({ id: "root-cut", assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "other-chat" } } }));
    first.runtime.close();

    const second = world(() => "hold", {}, store);
    expect(second.runner.parks).toEqual([{ a: expect.objectContaining({ id: "root-parked", cards: ["msg-1", "msg-2"] }), question: "Connect GitHub" }]);
    expect(store.get("root-parked")).toMatchObject({ status: "needs_input", restarts: 0 });
    expect(store.get("root-cut")).toMatchObject({ status: "queued", restart: "rerun", restarts: 1, executions: 1 });
    expect(store.inbox({ threadId: "chief-chat" })).toEqual([]);
    second.runtime.tick();
    expect(second.runner.runs.map(r => r.a.id)).toEqual(["root-cut"]);
    expect(second.runner.runs[0]!.input).toMatchObject({ turn: "rerun", resumed: true, restartNote: expect.stringMatching(/^OpenMausBot restarted while your previous turn here was running/) });
    expect(store.get("root-cut")).toMatchObject({ status: "running", executions: 2 });
    second.runtime.close();

    const third = world(undefined, {}, store);
    expect(store.get("root-cut")).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 1, result: CUT_TWICE });
    expect(store.get("root-cut")?.restart).toBeUndefined();
    expect(third.runner.reports.map(r => [r.a.id, r.parent])).toEqual([["root-cut", undefined]]);
    expect(store.get("root-parked")?.status).toBe("needs_input");
    expect(third.runner.parks.map(p => p.a.id)).toEqual(["root-parked"]);
    third.runtime.tick();
    expect(third.runner.runs).toEqual([]);
    invariants(third);
    expect(cut.id).toBe("root-cut");
    store.close();
  });

  it("prune() removes terminal trees older than before and leaves a parked root's tree alone", async () => {
    const w = world();
    const old = w.runtime.begin(beginReq({ id: "old" }));
    w.runtime.end(old.id, { ok: true, text: "done" });
    const parked = w.runtime.begin(beginReq({ id: "parked", assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "other-chat" } } }));
    w.runtime.end(parked.id, { ok: true, text: "", needsInput: cards });
    w.clock.advance(1_000);
    expect(w.runtime.prune(w.clock.t)).toBe(1);
    expect(w.store.get("old")).toBeUndefined();
    expect(w.store.get("parked")).toMatchObject({ status: "needs_input", cards: ["msg-1", "msg-2"] });
    expect(w.runtime.prune(w.clock.t)).toBe(0);
    invariants(w);
  });
});

describe("Runtime: a cut turn that already acted outward (contract §5)", () => {
  it("open() asks the host once per cut node, ends one that acted outward failed(interrupted) with what it did, and the requester's note names it", async () => {
    const store = openRuntimeStore(":memory:");
    const first = world(() => "hold", {}, store);
    const root = first.runtime.begin(beginReq());
    const sender = ok(first.runtime.enqueue(toBot("sender", root.id)));
    const quiet = ok(first.runtime.enqueue(toBot("quiet", root.id)));
    first.runtime.tick();
    expect(first.runner.runs).toHaveLength(2);
    first.runtime.end(root.id, { ok: true, text: "handed out" });
    first.runtime.close();

    const asked: string[] = [];
    const second = world(undefined, {}, store, { outward: a => { asked.push(a.assignee.botId); return a.assignee.botId === "sender" ? ["GMAIL_SEND_EMAIL"] : []; } });
    expect(asked.sort()).toEqual(["quiet", "sender"]);
    expect(store.get(sender.id)).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 0, executions: 1,
      outcomeDetail: `${INTERRUPTED_OUTWARD} sent an email (GMAIL_SEND_EMAIL); not resumed, so nothing is done twice.` });
    expect(store.get(sender.id)?.restart).toBeUndefined();
    expect(store.events(sender.id).map(e => e.kind)).toEqual(["enqueued", "admitted", "started", "restart_reconciled", "settled", "reported", "woken"]);
    expect(store.events(sender.id).find(e => e.kind === "restart_reconciled")?.detail).toBe("failed: outward action done");
    expect(store.get(quiet.id)).toMatchObject({ status: "queued", restart: "rerun", restarts: 1 });
    expect(second.runner.reports.map(r => [r.a.id, r.parent?.id])).toEqual([[sender.id, root.id]]);
    expect(store.get(root.id)).toMatchObject({ status: "waiting", restart: "teammates" });
    invariants(second);

    second.runtime.tick(); await flush();
    expect(store.get(quiet.id)).toMatchObject({ status: "completed", restarts: 1 });
    second.runtime.tick();
    const resume = second.runner.runs.find(r => r.a.id === root.id)!;
    expect(resume.input.turn).toBe("resume");
    expect(resume.input.settled?.map(s => [s.id, s.outcome])).toEqual([[sender.id, "interrupted"], [quiet.id, "done"]]);
    expect(resume.input.restartNote).toBe("A restart cut these teammates' turns: sender (cut after an outward action, not resumed: see its result); quiet (resumed once in place and told to check what it had already done). Check their results as usual.\n");
    await flush();
    expect(store.get(root.id)?.status).toBe("completed");
    invariants(second);
    store.close();
  });

  it("a root cut during its own turn that acted outward ends alone, reported into its own conversation, and is never run", async () => {
    const store = openRuntimeStore(":memory:");
    const first = world(undefined, {}, store);
    const root = first.runtime.begin(beginReq());
    first.runtime.close();
    const second = world(undefined, {}, store, { outward: () => ["git push"] });
    expect(store.get(root.id)).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 0, executions: 1, result: `${INTERRUPTED_OUTWARD} pushed (git push); not resumed, so nothing is done twice.` });
    expect(second.runner.reports).toEqual([{ a: expect.objectContaining({ id: root.id, outcome: "interrupted" }) }]);
    expect(store.inbox({ threadId: "chief-chat" })).toEqual([]);
    second.runtime.tick(); await flush();
    expect(second.runner.runs).toEqual([]);
    invariants(second);
    store.close();
  });
});

describe("tree.ts: the outward wording and the loop guard", () => {
  it("outwardDetail dedupes, trims and clips the labels, names at most four as verb phrases, and keeps the exact prefix and close", () => {
    expect(outwardDetail(["git push", "git push", "  GMAIL_SEND_EMAIL  "]))
      .toBe("Interrupted by an OpenMausBot restart after it already pushed (git push), sent an email (GMAIL_SEND_EMAIL); not resumed, so nothing is done twice.");
    expect(outwardDetail(["git commit", "STRIPE_CREATE_REFUND", "SLACK_SEND_MESSAGE", "TWITTER_CREATION_OF_A_POST", "COMPOSIO_PROXY_EXECUTE", "x"]))
      .toBe(`${INTERRUPTED_OUTWARD} committed (git commit), made a payment (STRIPE_CREATE_REFUND), sent a message (SLACK_SEND_MESSAGE), posted (TWITTER_CREATION_OF_A_POST) and 2 more; not resumed, so nothing is done twice.`);
    expect(outwardDetail(["COMPOSIO_PROXY_EXECUTE"])).toContain("completed an outward action (COMPOSIO_PROXY_EXECUTE)");
    const long = outwardDetail([`git push ${"origin/".repeat(20)}`, "", "   "]);
    expect(long).toMatch(/^Interrupted by an OpenMausBot restart after it already pushed \(git push [^)]{0,40}\); not resumed, so nothing is done twice\.$/);
    expect(long.length).toBeLessThan(200);
    expect(outwardDetail(["a\nb\tc"])).toContain("(a b c)");
  });

  it("nextGuard counts consecutive no-progress continuations, resets on progress, leaves unknown evidence alone, and keeps the last three errors clipped", () => {
    expect(nextGuard(undefined, undefined)).toEqual({ stale: 0, errors: [] });
    expect(nextGuard(undefined, { okToolCalls: 0 })).toEqual({ stale: 1, errors: [] });
    expect(nextGuard({ stale: 1, errors: [] }, { okToolCalls: 0 })).toEqual({ stale: 2, errors: [] });
    expect(nextGuard({ stale: 1, errors: ["E"] }, { okToolCalls: 2 })).toEqual({ stale: 0, errors: ["E"] });
    expect(nextGuard({ stale: 1, errors: ["E"] }, { commands: 3 })).toEqual({ stale: 1, errors: ["E"] });
    expect(nextGuard({ stale: 1, errors: ["E"] }, undefined)).toEqual({ stale: 1, errors: ["E"] });
    expect(nextGuard({ stale: 0, errors: ["A", "B"] }, { errors: ["C", "D"] })).toEqual({ stale: 0, errors: ["B", "C", "D"] });
    expect(nextGuard(undefined, { errors: ["", "  ", " E "] })).toEqual({ stale: 0, errors: ["E"] });
    expect(nextGuard(undefined, { errors: ["x".repeat(300)] }).errors[0]).toHaveLength(200);
  });

  it("loopStop stops on two stale continuations or three identical errors, with the reason for the event and the detail for the outcome", () => {
    expect(loopStop({ stale: 0, errors: [] }, "x")).toBeUndefined();
    expect(loopStop({ stale: 1, errors: ["E", "E"] }, "x")).toBeUndefined();
    expect(loopStop({ stale: 0, errors: ["E", "F", "E"] }, "x")).toBeUndefined();
    expect(loopStop({ stale: 2, errors: [] }, ` still going ${"y".repeat(400)}`))
      .toEqual({ reason: "2 continuations without a successful tool call", detail: `Stopped after 2 continuations without progress: ${`still going ${"y".repeat(400)}`.slice(0, 300)}` });
    expect(loopStop({ stale: 3, errors: [] }, "x")?.detail).toBe("Stopped after 3 continuations without progress: x");
    expect(loopStop({ stale: 0, errors: ["E", "E", "E"] }, "x")).toEqual({ reason: "the same error 3 times", detail: "Stopped after 3 identical errors: E" });
    expect(loopStop({ stale: 2, errors: ["E", "E", "E"] }, "x")?.reason).toBe("2 continuations without a successful tool call");
  });
});

describe("Runtime: a teammate's question reaches the requester waiting on it", () => {
  const asks: Script = (a, input) => a.assignee.botId === "builder" && input.answer === undefined ? { kind: "needs_input", question: "Which region?" }
    : a.assignee.botId === "tester" ? "hold" : undefined;
  const runsOf = (w: World, id: string) => w.runner.runs.filter(r => r.a.id === id);

  it("resumes the requester once with the question, keeps the sibling awaited, and resumes it again only when everything settled", async () => {
    const w = world(asks);
    const root = w.runtime.begin(beginReq());
    const builder = ok(w.runtime.enqueue(toBot("builder", root.id)));
    const tester = ok(w.runtime.enqueue(toBot("tester", root.id)));
    w.runtime.end(root.id, { ok: true, text: "Handed out" });
    w.runtime.tick(); await flush();
    expect(w.store.get(builder.id)).toMatchObject({ status: "needs_input", question: "Which region?" });
    expect(w.store.get(root.id)?.status).toBe("waiting");

    w.runtime.tick();
    expect(runsOf(w, root.id)).toHaveLength(1);
    const resume = runsOf(w, root.id)[0]!.input;
    expect(resume).toMatchObject({ turn: "resume", resumed: true });
    expect(resume.asked?.map(a => [a.id, a.question])).toEqual([[builder.id, "Which region?"]]);
    expect(resume.settled).toBeUndefined();
    expect(w.store.inbox({ threadId: "chief-chat" }, true)).toEqual([]);
    await flush();
    expect(w.store.get(root.id)?.status).toBe("waiting");
    expect(w.store.get(tester.id)?.status).toBe("running");
    w.runtime.tick(); await flush(); w.runtime.tick(); await flush();
    expect(runsOf(w, root.id)).toHaveLength(1);

    expect(w.runtime.answer(builder.id, "eu-west")).toBe(true);
    w.runtime.tick(); await flush();
    expect(runsOf(w, builder.id).at(-1)?.input).toMatchObject({ turn: "answered", answer: "eu-west" });
    expect(w.store.get(builder.id)?.status).toBe("completed");
    w.runtime.tick(); await flush();
    expect(runsOf(w, root.id)).toHaveLength(1);
    expect(w.store.get(root.id)?.status).toBe("waiting");

    await w.runner.release(tester.id, { kind: "completed", text: "tested" });
    w.runtime.tick();
    const final = runsOf(w, root.id)[1]!.input;
    expect(final.settled?.map(a => a.id)).toEqual([builder.id, tester.id]);
    expect(final.asked).toBeUndefined();
    await flush();
    expect(w.store.get(root.id)?.status).toBe("completed");
    expect(w.store.events(root.id).filter(e => e.kind === "resume_due").map(e => e.detail)).toEqual(["resume: a teammate asks", "resume"]);
    invariants(w);
  });

  it("a question parked before a restart resumes the requester once after it, and not again after the next restart", async () => {
    const store = openRuntimeStore(":memory:");
    const first = world(asks, {}, store);
    const root = first.runtime.begin(beginReq());
    const builder = ok(first.runtime.enqueue(toBot("builder", root.id)));
    ok(first.runtime.enqueue(toBot("tester", root.id)));
    first.runtime.end(root.id, { ok: true, text: "Handed out" });
    first.runtime.tick(); await flush();
    expect(store.get(builder.id)?.status).toBe("needs_input");
    first.runtime.close();

    const second = world(asks, {}, store);
    second.runtime.tick();
    expect(runsOf(second, root.id).map(r => r.input.asked?.map(a => a.id))).toEqual([[builder.id]]);
    await flush();
    expect(store.get(root.id)?.status).toBe("waiting");
    second.runtime.close();

    const third = world(asks, {}, store);
    third.runtime.tick(); await flush(); third.runtime.tick(); await flush();
    expect(runsOf(third, root.id)).toEqual([]);
    expect(store.get(root.id)?.status).toBe("waiting");
    expect(store.get(builder.id)?.status).toBe("needs_input");
    expect(third.runner.parks.map(p => p.a.id)).toEqual([builder.id]);
    invariants(third);
  });

  it("an unanswered question still expires after 30 minutes, and the expiry resumes the requester with the results", async () => {
    const w = world((a, input) => a.assignee.botId === "builder" && input.answer === undefined ? { kind: "needs_input", question: "Which region?" } : undefined);
    const root = w.runtime.begin(beginReq());
    const builder = ok(w.runtime.enqueue(toBot("builder", root.id)));
    const tester = ok(w.runtime.enqueue(toBot("tester", root.id)));
    w.runtime.end(root.id, { ok: true, text: "Handed out" });
    w.runtime.tick(); await flush();
    w.runtime.tick();
    expect(runsOf(w, root.id).map(r => [r.input.asked?.map(a => a.id), r.input.settled?.map(a => a.id)])).toEqual([[[builder.id], [tester.id]]]);
    await flush();
    w.clock.advance(30 * 60_000);
    w.runtime.tick();
    expect(w.store.get(builder.id)?.status).toBe("needs_input");
    w.clock.advance(1);
    w.runtime.tick();
    expect(w.store.get(builder.id)).toMatchObject({ status: "failed", outcome: "expired", outcomeDetail: "the person did not answer" });
    expect(runsOf(w, root.id)).toHaveLength(2);
    expect(runsOf(w, root.id)[1]!.input.settled?.map(a => a.id)).toEqual([builder.id, tester.id]);
    await flush();
    expect(w.store.get(root.id)?.status).toBe("completed");
    invariants(w);
  });

  it("a teammate parked on cards neither resumes the requester nor expires", async () => {
    const w = world(a => a.assignee.botId === "builder" ? { kind: "needs_input", question: "Connect GitHub", cards: ["msg-1"] } : undefined);
    const root = w.runtime.begin(beginReq());
    const builder = ok(w.runtime.enqueue(toBot("builder", root.id)));
    w.runtime.end(root.id, { ok: true, text: "Handed out" });
    w.runtime.tick(); await flush();
    w.clock.advance(400 * 24 * 60 * 60_000);
    w.runtime.tick(); await flush(); w.runtime.tick();
    expect(runsOf(w, root.id)).toEqual([]);
    expect(w.store.get(root.id)?.status).toBe("waiting");
    expect(w.store.get(builder.id)).toMatchObject({ status: "needs_input", cards: ["msg-1"] });
    expect(w.store.inbox({ threadId: "chief-chat" }, true).map(i => [i.assignmentId, i.kind])).toEqual([[builder.id, "needs_input"]]);
    invariants(w);
  });

  it("a question answered while the requester's thread was busy does not resume it with nothing to review", async () => {
    const w = world(asks);
    const root = w.runtime.begin(beginReq());
    const builder = ok(w.runtime.enqueue(toBot("builder", root.id)));
    ok(w.runtime.enqueue(toBot("tester", root.id)));
    w.runtime.end(root.id, { ok: true, text: "Handed out" });
    w.runtime.tick(); await flush();
    w.runner.canStartAnswer = false;
    w.runtime.tick();
    expect(w.store.get(root.id)?.status).toBe("resume");
    w.runtime.answer(builder.id, "eu-west");
    w.runtime.tick();
    expect(w.store.get(root.id)?.status).toBe("waiting");
    expect(w.store.events(root.id).at(-1)).toMatchObject({ kind: "waiting", detail: "waiting: nothing left to resume for" });
    w.runner.canStartAnswer = true;
    w.runtime.tick(); await flush(); w.runtime.tick(); await flush();
    expect(w.store.get(builder.id)?.status).toBe("completed");
    expect(runsOf(w, root.id)).toEqual([]);
    expect(w.store.get(root.id)?.status).toBe("waiting");
    invariants(w);
  });

  it("results that settle while the requester's question turn runs reach it in one final resume", async () => {
    const w = world((a, input) => a.assignee.botId === "chief" && input.asked ? "hold" : asks(a, input));
    const root = w.runtime.begin(beginReq());
    const builder = ok(w.runtime.enqueue(toBot("builder", root.id)));
    const tester = ok(w.runtime.enqueue(toBot("tester", root.id)));
    w.runtime.end(root.id, { ok: true, text: "Handed out" });
    w.runtime.tick(); await flush();
    w.runtime.tick(); await flush();
    expect(runsOf(w, root.id).map(r => r.input.asked?.map(a => a.id))).toEqual([[builder.id]]);
    expect(w.store.get(root.id)?.status).toBe("running");

    w.runtime.answer(builder.id, "eu-west");
    w.runtime.tick(); await flush();
    expect(w.store.get(builder.id)?.status).toBe("completed");
    await w.runner.release(tester.id, { kind: "completed", text: "tested" });
    w.runtime.tick(); await flush();
    expect(runsOf(w, root.id)).toHaveLength(1);
    await w.runner.release(root.id, { kind: "completed", text: "Passed the question on" });
    expect(w.store.get(root.id)?.status).toBe("waiting");

    w.runtime.tick();
    const final = runsOf(w, root.id)[1]?.input;
    expect(final).toMatchObject({ turn: "resume", resumed: true });
    expect(final?.settled?.map(a => a.id)).toEqual([builder.id, tester.id]);
    expect(final?.asked).toBeUndefined();
    expect(w.store.inbox({ threadId: "chief-chat" }, true)).toEqual([]);
    await flush();
    expect(w.store.get(root.id)?.status).toBe("completed");
    expect(runsOf(w, root.id)).toHaveLength(2);
    invariants(w);
  });

  it("a restart during the question turn reruns it once with the question, and no later turn carries it again", async () => {
    const store = openRuntimeStore(":memory:");
    const first = world((a, input) => a.assignee.botId === "chief" && input.asked ? "hold" : asks(a, input), {}, store);
    const root = first.runtime.begin(beginReq());
    const builder = ok(first.runtime.enqueue(toBot("builder", root.id)));
    const tester = ok(first.runtime.enqueue(toBot("tester", root.id)));
    first.runtime.end(root.id, { ok: true, text: "Handed out" });
    first.runtime.tick(); await flush();
    first.runtime.tick(); await flush();
    expect(runsOf(first, root.id).map(r => r.input.asked?.map(a => a.id))).toEqual([[builder.id]]);
    first.runtime.close();

    const second = world(asks, {}, store);
    second.runtime.tick(); await flush();
    second.runtime.tick(); await flush(); second.runtime.tick(); await flush();
    const reruns = runsOf(second, root.id);
    expect(reruns.map(r => [r.input.turn, r.input.asked?.map(a => a.id)])).toEqual([["resume", [builder.id]]]);
    expect(reruns[0]!.input.restartNote).toMatch(/restarted while your previous turn here was running and cut it off; this turn continues it/);
    expect(store.get(root.id)).toMatchObject({ status: "waiting", restarts: 1 });
    expect(store.get(root.id)?.carrying).toBeUndefined();

    second.runtime.answer(builder.id, "eu-west");
    second.runtime.tick(); await flush();
    await second.runner.release(tester.id, { kind: "completed", text: "tested" });
    second.runtime.tick(); await flush();
    const after = runsOf(second, root.id).slice(1);
    expect(after.map(r => [r.input.turn, r.input.asked, r.input.settled?.map(a => a.id)])).toEqual([["resume", undefined, [builder.id, tester.id]]]);
    expect(store.get(root.id)?.status).toBe("completed");
    invariants(second);
  });

  it("the requester's own later turns do not carry a question its question turn already passed on", async () => {
    const w = world((a, input) => a.assignee.botId === "chief" && input.asked ? { kind: "needs_input", question: "Which region for builder?" } : asks(a, input));
    const root = w.runtime.begin(beginReq());
    const builder = ok(w.runtime.enqueue(toBot("builder", root.id)));
    ok(w.runtime.enqueue(toBot("tester", root.id)));
    w.runtime.end(root.id, { ok: true, text: "Handed out" });
    w.runtime.tick(); await flush();
    w.runtime.tick(); await flush();
    expect(runsOf(w, root.id).map(r => r.input.asked?.map(a => a.id))).toEqual([[builder.id]]);
    expect(w.store.get(root.id)?.status).toBe("needs_input");

    expect(w.runtime.answer(root.id, "eu-west")).toBe(true);
    w.runtime.tick(); await flush();
    const answered = runsOf(w, root.id)[1]?.input;
    expect(answered).toMatchObject({ turn: "answered", answer: "eu-west" });
    expect(answered?.asked).toBeUndefined();
    expect(w.store.get(builder.id)?.status).toBe("needs_input");
    expect(w.store.get(root.id)?.status).toBe("waiting");
    w.runtime.tick(); await flush();
    expect(runsOf(w, root.id)).toHaveLength(2);
    invariants(w);
  });
});
