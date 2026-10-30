import { afterEach, describe, expect, it } from "vitest";

import { ENVELOPE_MARK } from "./envelope.ts";
import { checkInvariants, replayStatus } from "./invariants.ts";
import { Runtime, type BeginRequest } from "./runtime.ts";
import { openRuntimeStore, type RuntimeStore } from "./store.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { complete, continueTurn, custom, fail, FakeRunner, handOut, hang, needsInput, type ChildSpec } from "./testing/fake-runner.ts";
import { CUT_TWICE, INTERRUPTED_OUTWARD } from "./tree.ts";
import {
  terminal,
  type Assignment,
  type Assignee,
  type EnqueueResult,
  type Limits,
  type Origin,
  type Owner,
  type Requester,
  type Status,
} from "./types.ts";

const BOTS = {
  chief: { name: "Chief", chief: true },
  dev: { name: "Dev" },
  qa: { name: "QA" },
  ops: { name: "Ops" },
};

const CHIEF_THREAD = "thread-chief";
const PERSON_QUOTE = "Ship the release";
const chiefOwner: Owner = { botId: "chief", threadId: CHIEF_THREAD };

interface World {
  store: RuntimeStore;
  clock: FakeClock;
  runner: FakeRunner;
  rt: Runtime;
  limits: Partial<Limits>;
  logs: string[];
}

const worlds: World[] = [];

function world(limits: Partial<Limits> = {}, ports: { outward?: boolean } = {}): World {
  const store = openRuntimeStore(":memory:");
  const clock = new FakeClock();
  const runner = new FakeRunner(BOTS, ports);
  const logs: string[] = [];
  const rt = new Runtime(store, runner, { clock, limits, log: (line) => logs.push(line) });
  runner.attach(rt);
  runner.lookup = (id) => store.get(id);
  rt.open();
  const w: World = { store, clock, runner, rt, limits, logs };
  worlds.push(w);
  return w;
}

/** The host process dies and comes back on the same database. */
function reopen(w: World): void {
  w.rt.close();
  w.runner.reboot();
  w.rt = new Runtime(w.store, w.runner, { clock: w.clock, limits: w.limits, log: (line) => w.logs.push(line) });
  w.runner.attach(w.rt);
  w.rt.open();
}

afterEach(() => {
  for (const w of worlds.splice(0)) {
    w.rt.close();
    w.store.close();
  }
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function signature(w: World): string {
  const rows = w.store.all().map((a) => `${a.id}:${a.status}:${a.executions}:${a.restart ?? ""}`).join("|");
  const calls = w.runner.calls.filter((c) => c.method === "run" || c.method === "park" || c.method === "report").length;
  return `${rows}#${calls}#${w.runner.running.size}`;
}

async function drain(w: World, max = 60): Promise<void> {
  let last = "";
  for (let i = 0; i < max; i++) {
    await flush();
    w.rt.tick();
    await flush();
    const now = signature(w);
    if (now === last) return;
    last = now;
  }
  throw new Error(`drain: the runtime did not settle in ${max} rounds`);
}

function get(w: World, id: string): Assignment {
  const a = w.store.get(id);
  if (!a) throw new Error(`no assignment ${id}`);
  return a;
}

function invariants(w: World): void {
  expect(checkInvariants(w.store, w.runner.live())).toEqual([]);
}

function ok(r: EnqueueResult): Assignment {
  if (!r.ok) throw new Error(`enqueue refused: ${r.outcome}: ${r.reason}`);
  return r.assignment;
}

function refused(r: EnqueueResult | undefined): { reason: string; outcome: "refused" | "budget" | "duplicate" } {
  if (!r) throw new Error("no enqueue result recorded");
  if (r.ok) throw new Error(`expected a refusal, got ${r.assignment.id}`);
  return r;
}

const personOrigin = (): Origin => ({ kind: "person", source: "chat", ref: CHIEF_THREAD, quote: PERSON_QUOTE });
const chiefAssignee = (): Assignee => ({ botId: "chief", destination: { kind: "standing_thread", threadId: CHIEF_THREAD } });

function beginChief(w: World, over: Partial<BeginRequest> = {}): Assignment {
  return w.rt.begin({
    origin: personOrigin(),
    requester: { kind: "person", threadId: CHIEF_THREAD, chief: true },
    assignee: chiefAssignee(),
    brief: PERSON_QUOTE,
    level: "auto",
    ...over,
  });
}

let seq = 0;
function workFor(bot: string, brief: string, over: Partial<ChildSpec> = {}): ChildSpec {
  seq += 1;
  return { assignee: { botId: bot, destination: { kind: "work_thread", threadId: `work-${bot}-${seq}` } }, brief, ...over };
}

function enqueueFrom(w: World, parent: Assignment, spec: ChildSpec): EnqueueResult {
  return w.rt.enqueue(w.runner.childRequest(parent, spec));
}

const kinds = (w: World, id: string): string[] => w.store.events(id).map((e) => e.kind);

describe("§2 lifecycle", () => {
  it("S01 person → Chief root → one teammate completes → Chief resumes exactly once", async () => {
    const w = world();
    const root = beginChief(w);
    expect(root.status).toBe("running");
    expect(root.depth).toBe(0);
    expect(root.rootId).toBe(root.id);
    expect(root.executions).toBe(1);
    expect(root.reply).toBe("resume");

    const child = ok(enqueueFrom(w, root, workFor("dev", "Build the thing")));
    expect(child.status).toBe("queued");
    expect(child.parentId).toBe(root.id);
    expect(child.rootId).toBe(root.id);
    expect(child.depth).toBe(1);
    expect(child.origin).toEqual(root.origin);
    expect(child.mode).toBe("work");
    expect(child.reply).toBe("resume");
    expect(kinds(w, child.id)).toEqual(["enqueued"]);

    w.runner.script("dev", complete("built"));
    w.runner.script("chief", complete("all done"));
    w.rt.end(root.id, { ok: true, text: "handed out" });
    expect(get(w, root.id).status).toBe("waiting");
    expect(w.runner.runs()).toHaveLength(0);

    w.rt.tick();
    expect(get(w, child.id).status).toBe("running");
    expect(w.runner.running.has(child.id)).toBe(true);
    expect(w.rt.liveEdges()).toEqual([
      expect.objectContaining({ sourceBotId: "chief", targetBotId: "dev", state: "running", threadId: child.assignee.destination.threadId }),
    ]);
    expect(w.rt.outstanding(chiefOwner).map((a) => a.id)).toEqual([child.id]);
    invariants(w);

    await drain(w);

    const c = get(w, child.id);
    expect(c.status).toBe("completed");
    expect(c.outcome).toBe("done");
    expect(c.result).toBe("built");
    expect(c.executions).toBe(1);
    expect(c.finishedAt).toBeDefined();
    expect(c.reportedAt).toBeDefined();

    const childRuns = w.runner.runs(child.id);
    expect(childRuns).toHaveLength(1);
    const input = childRuns[0].input!;
    expect(input.envelope.startsWith(ENVELOPE_MARK)).toBe(true);
    expect(input.mode).toBe("work");
    expect(input.level).toBe(c.level);
    expect(input.answer).toBeUndefined();
    expect(input.settled ?? []).toHaveLength(0);
    expect(childRuns[0].settledAborted).toBe(false);

    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((a) => a.id)).toEqual([child.id]);
    expect(rootRuns[0].input!.settled?.[0].outcome).toBe("done");
    expect(rootRuns[0].input!.mode).toBe("work");

    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.reports(child.id)[0].parent?.id).toBe(root.id);
    expect(w.runner.reports(root.id)).toHaveLength(0);

    const inbox = w.store.inbox(chiefOwner, false);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "settled", assignmentId: child.id });
    expect(inbox[0].deliveredAt).toBeDefined();
    expect(w.store.inbox(chiefOwner, true)).toHaveLength(0);

    const r = get(w, root.id);
    expect(r.status).toBe("completed");
    expect(r.outcome).toBe("done");
    expect(r.executions).toBe(2);
    expect(w.rt.liveEdges()).toEqual([]);
    expect(w.rt.outstanding(chiefOwner)).toEqual([]);

    const ck = kinds(w, child.id);
    expect(ck[0]).toBe("enqueued");
    expect(ck).toContain("started");
    expect(ck).toContain("settled");
    expect(ck).toContain("reported");
    expect(w.rt.status(root.id)?.children.map((a) => a.id)).toEqual([child.id]);
    invariants(w);
  });

  it("S02 a duplicate brief returns the existing row; rework runs it again", async () => {
    const w = world();
    const root = beginChief(w);
    const spec = workFor("dev", "Write the docs");
    const first = w.rt.enqueue(w.runner.childRequest(root, spec));
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const firstRow = ok(first);
    const again = w.rt.enqueue(w.runner.childRequest(root, spec));
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(ok(again).id).toBe(firstRow.id);
    expect(w.store.all()).toHaveLength(2);

    w.runner.script("dev", complete("v1"), complete("v2"));
    let dup: EnqueueResult | undefined;
    let rework: EnqueueResult | undefined;
    w.runner.script(
      "chief",
      custom(({ handOut: give }) => {
        dup = give(spec);
        rework = give({ ...spec, rework: true });
        return { kind: "completed", text: "asked again" };
      }),
      complete("final"),
    );
    w.rt.end(root.id, { ok: true, text: "handed out" });
    await drain(w);

    expect(dup).toMatchObject({ ok: true, duplicate: true });
    expect(ok(dup!).id).toBe(firstRow.id);
    expect(rework).toMatchObject({ ok: true, duplicate: false });
    const second = ok(rework!);
    expect(second.id).not.toBe(firstRow.id);
    expect(second.rework).toBe(true);
    expect(second.brief).toBe(firstRow.brief);

    expect(w.runner.runs(firstRow.id)).toHaveLength(1);
    expect(w.runner.runs(second.id)).toHaveLength(1);
    expect(get(w, firstRow.id)).toMatchObject({ status: "completed", result: "v1" });
    expect(get(w, second.id)).toMatchObject({ status: "completed", result: "v2" });
    expect(w.runner.reports(firstRow.id)).toHaveLength(1);
    expect(w.runner.reports(second.id)).toHaveLength(1);

    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(2);
    expect(rootRuns[0].input!.settled?.map((a) => a.id)).toEqual([firstRow.id]);
    // A resume returns every settled result, so the first round's result comes back again.
    expect(rootRuns[1].input!.settled?.map((a) => a.id)).toEqual([firstRow.id, second.id]);
    expect(get(w, root.id).status).toBe("completed");
    expect(w.store.all()).toHaveLength(3);
    invariants(w);
  });

  it("S03 the depth limit refuses with a typed reason", async () => {
    const w = world({ depth: 1 });
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    expect(child.depth).toBe(1);
    let grand: EnqueueResult | undefined;
    w.runner.script(
      "dev",
      custom(({ handOut: give }) => {
        grand = give(workFor("qa", "Test"));
        return { kind: "completed", text: "built alone" };
      }),
    );
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    const refusal = refused(grand);
    expect(refusal.outcome).toBe("refused");
    expect(typeof refusal.reason).toBe("string");
    expect(refusal.reason.length).toBeGreaterThan(0);
    expect(w.store.all({ nonTerminal: true })).toEqual([]);
    expect(w.store.all().filter((a) => a.assignee.botId === "qa" && !terminal(a.status))).toEqual([]);
    expect(get(w, child.id).status).toBe("completed");
    expect(get(w, root.id).status).toBe("completed");
    expect(w.runner.runs().filter((c) => c.a!.assignee.botId === "qa")).toHaveLength(0);
    invariants(w);
  });

  it("S04 work back to an ancestor is refused", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    let back: EnqueueResult | undefined;
    let backToRoot: EnqueueResult | undefined;
    let toSibling: EnqueueResult | undefined;
    w.runner.script(
      "dev",
      custom(({ a, handOut: give }) => {
        back = give({ assignee: chiefAssignee(), brief: "Please review" });
        backToRoot = give({ assignee: a.assignee, brief: "Do it myself" });
        toSibling = give(workFor("qa", "Test"));
        return { kind: "completed", text: "built" };
      }),
    );
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    expect(refused(back).outcome).toBe("refused");
    expect(refused(backToRoot).outcome).toBe("refused");
    const sibling = ok(toSibling!);
    expect(sibling.parentId).toBe(child.id);
    expect(sibling.depth).toBe(2);
    expect(get(w, sibling.id).status).toBe("completed");
    expect(get(w, child.id).status).toBe("completed");
    expect(get(w, root.id).status).toBe("completed");
    expect(w.store.all().filter((a) => a.assignee.botId === "chief")).toHaveLength(1);
    invariants(w);
  });

  it("S05 consult mode runs with RunInput.mode consult", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "What does the build do?", { mode: "consult" })));
    expect(child.mode).toBe("consult");
    expect(child.reply).toBe("resume");
    w.runner.script("dev", complete("it builds"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    const runs = w.runner.runs(child.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].input!.mode).toBe("consult");
    expect(runs[0].input!.envelope.startsWith(ENVELOPE_MARK)).toBe(true);
    expect(get(w, child.id)).toMatchObject({ status: "completed", outcome: "done", result: "it builds" });
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)[0].input!.settled?.map((a) => a.id)).toEqual([child.id]);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S06 notify mode: no inbox, no resume, terminal recorded", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "FYI: release at 5", { mode: "notify", reply: "none" })));
    expect(child.mode).toBe("notify");
    expect(child.reply).toBe("none");
    w.runner.script("dev", complete("noted"));
    w.rt.end(root.id, { ok: true, text: "told dev" });
    await drain(w);

    const c = get(w, child.id);
    expect(c.status).toBe("completed");
    expect(c.outcome).toBe("done");
    expect(kinds(w, child.id)).toContain("settled");
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(w.runner.runs(child.id)[0].input!.mode).toBe("notify");
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(w.runner.reports(child.id).length).toBeLessThanOrEqual(1);
    const r = get(w, root.id);
    expect(terminal(r.status)).toBe(true);
    expect(r.status).toBe("completed");
    invariants(w);
  });

  it("S07 needs_input: park, answer(), the next run carries the answer", async () => {
    const w = world({ stallMs: 60_000, inputWaitMs: 600_000 });
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Pick a colour")));
    w.runner.script("dev", needsInput("Which colour?"), complete("blue it is"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    const parked = get(w, child.id);
    expect(parked.status).toBe("needs_input");
    expect(parked.question).toBe("Which colour?");
    expect(parked.answer).toBeUndefined();
    expect(w.runner.parks(child.id)).toHaveLength(1);
    expect(w.runner.parks(child.id)[0].question).toBe("Which colour?");
    expect(w.runner.parked.has(child.id)).toBe(true);
    expect(w.runner.running.size).toBe(0);
    expect(kinds(w, child.id)).toContain("parked");
    expect(get(w, root.id).status).toBe("waiting");
    expect(w.rt.liveEdges()).toEqual([expect.objectContaining({ targetBotId: "dev", state: "needs_input" })]);
    invariants(w);

    w.clock.advance(120_000);
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");
    expect(get(w, root.id).status).toBe("waiting");

    expect(w.rt.answer("no-such-id", "x")).toBe(false);
    expect(w.rt.answer(root.id, "x")).toBe(false);
    expect(w.rt.answer(child.id, "blue")).toBe(true);
    expect(kinds(w, child.id)).toContain("answered");
    await drain(w);

    const runs = w.runner.runs(child.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].input!.answer).toBeUndefined();
    expect(runs[1].input!.answer).toBe("blue");
    expect(runs[1].input!.envelope.startsWith(ENVELOPE_MARK)).toBe(true);
    const done = get(w, child.id);
    expect(done).toMatchObject({ status: "completed", outcome: "done", result: "blue it is" });
    expect(done.executions).toBe(2);
    expect(w.runner.parked.size).toBe(0);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.store.inbox(chiefOwner, false).filter((i) => i.kind === "settled")).toHaveLength(1);
    expect(w.runner.runs(root.id).map((run) => [run.input!.asked?.map((a) => a.id), run.input!.settled?.map((a) => a.id)]))
      .toEqual([[[child.id], undefined], [undefined, [child.id]]]);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S07b needs_input expiry → failed(expired), never completed, parent woken once (I5)", async () => {
    const w = world({ inputWaitMs: 1_000 });
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Pick a colour")));
    w.runner.script("dev", needsInput("Which colour?"), complete("never"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");

    w.clock.advance(999);
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");

    w.clock.advance(2);
    await drain(w);
    const c = get(w, child.id);
    expect(c.status).toBe("failed");
    expect(c.outcome).toBe("expired");
    expect(kinds(w, child.id)).not.toContain("answered");
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.parked.size).toBe(0);
    expect(w.rt.answer(child.id, "too late")).toBe(false);

    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(2);
    expect(rootRuns[0].input!.asked?.map((a) => a.id)).toEqual([child.id]);
    expect(rootRuns[1].input!.settled?.map((a) => [a.id, a.status, a.outcome])).toEqual([[child.id, "failed", "expired"]]);
    expect(w.store.inbox(chiefOwner, false).filter((i) => i.kind === "settled")).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§5 restart", () => {
  it("S08 a running leaf reruns once with RunInput.resumed; cut again → failed(interrupted), reported (I8)", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.script("dev", hang(), hang());
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("running");
    expect(w.runner.hungIds()).toEqual([child.id]);
    invariants(w);

    reopen(w);
    const afterOpen = get(w, child.id);
    expect(afterOpen.restart).toBe("rerun");
    expect(afterOpen.restarts).toBe(1);
    expect(terminal(afterOpen.status)).toBe(false);
    expect(kinds(w, child.id)).toContain("restart_reconciled");
    expect(get(w, root.id).status).toBe("waiting");
    expect(get(w, root.id).restart).toBe("teammates");
    await drain(w);

    const runs = w.runner.runs(child.id);
    expect(runs).toHaveLength(2);
    expect(runs[1].input!.resumed).toBe(true);
    expect(runs[1].input!.restartNote.length).toBeGreaterThan(0);
    expect(runs[1].input!.envelope.startsWith(ENVELOPE_MARK)).toBe(true);
    expect(runs[1].a!.restart).toBe("rerun");
    expect(runs[0].input!.resumed).toBe(false);
    expect(runs[0].input!.restartNote).toBe("");
    expect(get(w, child.id).status).toBe("running");
    expect(get(w, child.id).executions).toBe(2);
    invariants(w);

    reopen(w);
    await drain(w);
    const c = get(w, child.id);
    expect(c.status).toBe("failed");
    expect(c.outcome).toBe("interrupted");
    expect(c.restarts).toBe(1);
    expect(w.runner.runs(child.id)).toHaveLength(2);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.reports(child.id)[0].parent?.id).toBe(root.id);

    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((a) => [a.id, a.outcome])).toEqual([[child.id, "interrupted"]]);
    expect(rootRuns[0].a!.restart).toBe("teammates");
    expect(rootRuns[0].input!.restartNote.length).toBeGreaterThan(0);
    expect(get(w, root.id).status).toBe("completed");
    expect(get(w, root.id).restart).toBeUndefined();
    expect(w.store.inbox(chiefOwner, true)).toHaveLength(0);
    invariants(w);
  });

  it("S09 a running node that handed out work → waiting; its resume says cut", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.script("dev", handOut([workFor("qa", "Test")], hang()), complete("c done"));
    w.runner.script("qa", hang(), complete("g done"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    const grand = w.store.children(child.id)[0];
    expect(grand).toBeDefined();
    expect(get(w, child.id).status).toBe("running");
    expect(get(w, grand.id).status).toBe("running");
    expect(w.runner.hungIds().sort()).toEqual([child.id, grand.id].sort());
    invariants(w);

    reopen(w);
    const c = get(w, child.id);
    expect(c.status).toBe("waiting");
    expect(c.restart).toBe("cut");
    expect(c.restarts).toBe(0);
    expect(kinds(w, child.id)).toContain("restart_reconciled");
    const g = get(w, grand.id);
    expect(g.restart).toBe("rerun");
    expect(g.restarts).toBe(1);
    expect(get(w, root.id).restart).toBe("teammates");
    invariants(w);

    await drain(w);
    expect(w.runner.runs(grand.id)).toHaveLength(2);
    expect(get(w, grand.id)).toMatchObject({ status: "completed", result: "g done" });
    const childRuns = w.runner.runs(child.id);
    expect(childRuns).toHaveLength(2);
    expect(childRuns[1].input!.settled?.map((a) => a.id)).toEqual([grand.id]);
    expect(childRuns[1].a!.restart).toBe("cut");
    expect(childRuns[1].input!.restartNote.length).toBeGreaterThan(0);
    expect(get(w, child.id)).toMatchObject({ status: "completed", restarts: 0, result: "c done" });
    expect(get(w, child.id).restart).toBeUndefined();
    expect(w.runner.reports(grand.id)).toHaveLength(1);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S10 needs_input is re-parked at open and still answerable", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Pick a colour")));
    w.runner.script("dev", needsInput("Which colour?"), complete("blue"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");
    expect(w.runner.parks(child.id)).toHaveLength(1);

    reopen(w);
    expect(w.runner.parks(child.id)).toHaveLength(2);
    expect(w.runner.parks(child.id)[1].question).toBe("Which colour?");
    expect(w.runner.parked.has(child.id)).toBe(true);
    expect(get(w, child.id).status).toBe("needs_input");
    expect(get(w, child.id).restarts).toBe(0);
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");
    expect(w.runner.runs(child.id)).toHaveLength(1);
    invariants(w);

    expect(w.rt.answer(child.id, "blue")).toBe(true);
    await drain(w);
    const runs = w.runner.runs(child.id);
    expect(runs).toHaveLength(2);
    expect(runs[1].input!.answer).toBe("blue");
    expect(get(w, child.id)).toMatchObject({ status: "completed", result: "blue" });
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.runs(root.id).map((run) => [run.input!.asked?.map((a) => a.id), run.input!.settled?.map((a) => a.id)]))
      .toEqual([[[child.id], undefined], [undefined, [child.id]]]);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§6 budgets and clocks", () => {
  it("S11 24 requests accepted, the 25th refused as budget; a settlement renews the window", async () => {
    const w = world({ requests: 24, executions: 1_000, wakes: 1_000 });
    const root = beginChief(w);
    const children: Assignment[] = [];
    for (let i = 0; i < 24; i++) children.push(ok(enqueueFrom(w, root, workFor("dev", `Task ${i}`))));
    const over = refused(enqueueFrom(w, root, workFor("dev", "Task 24")));
    expect(over.outcome).toBe("budget");
    expect(over.reason.length).toBeGreaterThan(0);
    expect(w.store.all()).toHaveLength(25);
    expect(get(w, root.id).budgets?.requests).toBe(24);

    await drain(w);
    expect(children.every((c) => get(w, c.id).status === "completed")).toBe(true);
    expect(get(w, root.id).status).toBe("running");
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(w.store.inbox(chiefOwner, true)).toHaveLength(24);
    invariants(w);

    const renewed = ok(enqueueFrom(w, root, workFor("dev", "Task 24")));
    expect(renewed.status).toBe("queued");
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    expect(get(w, renewed.id).status).toBe("completed");
    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((a) => a.id).sort()).toEqual([...children.map((c) => c.id), renewed.id].sort());
    expect(w.store.inbox(chiefOwner, true)).toHaveLength(0);
    expect(w.store.inbox(chiefOwner, false)).toHaveLength(25);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S12 the owed resume turn runs even when executions are exhausted", async () => {
    const w = world({ executions: 0 });
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.rt.end(root.id, { ok: true, text: "" });
    expect(get(w, root.id).status).toBe("waiting");
    w.rt.cancel(child.id, "not needed");
    await drain(w);

    expect(get(w, child.id)).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(w.runner.runs(child.id)).toHaveLength(0);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((a) => a.id)).toEqual([child.id]);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S13 queue expiry: never started past queueMs → failed(expired)", async () => {
    const w = world({ queueMs: 1_000, stallMs: 1e9 });
    const root = beginChief(w);
    w.runner.setCanStart("dev", false);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("queued");

    w.clock.advance(999);
    await drain(w);
    expect(get(w, child.id).status).toBe("queued");
    invariants(w);

    w.clock.advance(2);
    await drain(w);
    const c = get(w, child.id);
    expect(c.status).toBe("failed");
    expect(c.outcome).toBe("expired");
    expect(c.startedAt).toBeUndefined();
    expect(c.executions).toBe(0);
    expect(w.runner.runs(child.id)).toHaveLength(0);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(kinds(w, child.id)).not.toContain("started");
    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((a) => [a.id, a.outcome])).toEqual([[child.id, "expired"]]);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S14 root stall: no durable progress for stallMs → tree failed(stalled), report(root) once (I4)", async () => {
    const w = world({ stallMs: 10_000, queueMs: 1e9 });
    const root = beginChief(w);
    w.runner.setCanStart("dev", false);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, root.id).status).toBe("waiting");

    w.clock.advance(9_999);
    await drain(w);
    expect(get(w, root.id).status).toBe("waiting");
    expect(get(w, child.id).status).toBe("queued");
    invariants(w);

    w.clock.advance(2);
    await drain(w);
    const r = get(w, root.id);
    expect(r.status).toBe("failed");
    expect(r.outcome).toBe("stalled");
    expect(kinds(w, root.id)).toContain("stalled");
    expect(terminal(get(w, child.id).status)).toBe(true);
    expect(w.runner.runs(child.id)).toHaveLength(0);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(w.runner.reports(root.id)).toHaveLength(1);
    expect(w.store.all({ nonTerminal: true })).toEqual([]);
    expect(w.rt.liveEdges()).toEqual([]);
    invariants(w);
  });

  it("S14b a root with a needs_input node is never stalled", async () => {
    const w = world({ stallMs: 10_000, inputWaitMs: 1e9 });
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Pick")));
    w.runner.script("dev", needsInput("Which?"), complete("ok"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");

    w.clock.advance(100_000);
    await drain(w);
    expect(get(w, root.id).status).toBe("waiting");
    expect(get(w, child.id).status).toBe("needs_input");
    expect(w.runner.reports(root.id)).toHaveLength(0);
    invariants(w);

    expect(w.rt.answer(child.id, "that one")).toBe(true);
    await drain(w);
    expect(get(w, child.id).status).toBe("completed");
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S15 per-turn stall: sleep() is not a stall, monotonic advance is; progress() resets it", async () => {
    const w = world({ turnStallMs: 5_000, stallMs: 1e9, queueMs: 1e9 });
    const root = beginChief(w);
    const a = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    const b = ok(enqueueFrom(w, root, workFor("qa", "Test")));
    w.runner.script("dev", hang());
    w.runner.script("qa", hang());
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, a.id).status).toBe("running");
    expect(get(w, b.id).status).toBe("running");

    w.clock.sleep(60 * 60_000);
    await drain(w);
    expect(get(w, a.id).status).toBe("running");
    expect(get(w, b.id).status).toBe("running");
    invariants(w);

    w.clock.advance(3_000);
    w.rt.progress(b.id);
    w.clock.advance(1_999);
    await drain(w);
    expect(get(w, a.id).status).toBe("running");
    expect(get(w, b.id).status).toBe("running");

    w.clock.advance(2);
    await drain(w);
    const stalledA = get(w, a.id);
    expect(stalledA.status).toBe("failed");
    expect(stalledA.outcome).toBe("stalled");
    expect(w.runner.runs(a.id)[0].signal!.aborted).toBe(true);
    expect(w.runner.reports(a.id)).toHaveLength(1);
    expect(get(w, b.id).status).toBe("running");
    expect(get(w, root.id).status).toBe("waiting");
    invariants(w);

    w.clock.advance(2_998);
    await drain(w);
    expect(get(w, b.id).status).toBe("running");
    w.clock.advance(2);
    await drain(w);
    const stalledB = get(w, b.id);
    expect(stalledB.status).toBe("failed");
    expect(stalledB.outcome).toBe("stalled");
    expect(w.runner.runs(b.id)[0].signal!.aborted).toBe(true);
    expect(w.runner.reports(b.id)).toHaveLength(1);
    expect(w.runner.running.size).toBe(0);

    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§2 cancel and stop awaiting", () => {
  it("S16 cancel cascades, aborts running signals, outcome stopped, reported", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.script("dev", handOut([workFor("qa", "Test")], hang()));
    w.runner.script("qa", hang());
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    const grand = w.store.children(child.id)[0];
    expect(get(w, child.id).status).toBe("running");
    expect(get(w, grand.id).status).toBe("running");
    invariants(w);

    w.rt.cancel(root.id, "person stopped it");
    for (const id of [root.id, child.id, grand.id]) {
      expect(get(w, id).status).toBe("cancelled");
      expect(get(w, id).outcome).toBe("stopped");
      expect(kinds(w, id)).toContain("cancelled");
    }
    expect(w.runner.runs(child.id)[0].signal!.aborted).toBe(true);
    expect(w.runner.runs(grand.id)[0].signal!.aborted).toBe(true);
    await drain(w);

    expect(w.runner.running.size).toBe(0);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.reports(grand.id)).toHaveLength(1);
    expect(w.runner.reports(root.id).length).toBeLessThanOrEqual(1);
    for (const id of [root.id, child.id, grand.id]) expect(get(w, id)).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(w.runner.runs(grand.id)).toHaveLength(1);
    expect(w.rt.liveEdges()).toEqual([]);
    expect(w.rt.outstanding(chiefOwner)).toEqual([]);
    invariants(w);
  });

  it("S17 stopRequester: queued children cancelled, the running child keeps going and reports, the requester never resumes", async () => {
    const w = world();
    const root = beginChief(w);
    const a = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    const b = ok(enqueueFrom(w, root, workFor("qa", "Test")));
    w.runner.script("dev", hang());
    w.runner.setCanStart("qa", false);
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, a.id).status).toBe("running");
    expect(get(w, b.id).status).toBe("queued");

    const left = w.rt.stopRequester(chiefOwner, "person stopped the chat");
    expect(left.map((x) => x.id)).toEqual([a.id]);
    expect(get(w, b.id)).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(get(w, root.id)).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(get(w, a.id).status).toBe("running");
    expect(w.runner.runs(a.id)[0].signal!.aborted).toBe(false);
    expect(w.runner.running.has(a.id)).toBe(true);
    await drain(w);
    expect(get(w, a.id).status).toBe("running");
    invariants(w);

    w.runner.release(a.id, complete("late but done"));
    await drain(w);
    expect(get(w, a.id)).toMatchObject({ status: "completed", outcome: "done", result: "late but done" });
    expect(w.runner.reports(a.id)).toHaveLength(1);
    expect(w.runner.reports(a.id)[0].parent?.id).toBe(root.id);
    expect(w.runner.reports(b.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(get(w, root.id).status).toBe("cancelled");
    expect(w.store.all({ nonTerminal: true })).toEqual([]);
    expect(w.rt.outstanding(chiefOwner)).toEqual([]);
    invariants(w);
  });
});

describe("§1 roots of every kind", () => {
  it("S18 external runtime root with reply poll: poll() returns each item once (I3), root completes with no turn", async () => {
    const w = world();
    const ext: Requester = { kind: "external_runtime", runId: "run-1" };
    const root = w.rt.begin({
      origin: { kind: "outside", source: "external_runtime", ref: "run-1" },
      requester: ext,
      assignee: { botId: "chief", destination: { kind: "work_thread", threadId: "ext-thread" } },
      brief: "Do two things",
      level: "ask",
      reply: "poll",
    });
    expect(root.reply).toBe("poll");
    const a = ok(enqueueFrom(w, root, workFor("dev", "Thing one", { requester: ext, reply: "poll" })));
    const b = ok(enqueueFrom(w, root, workFor("qa", "Thing two", { requester: ext, reply: "poll" })));
    w.runner.script("dev", complete("one"));
    w.runner.script("qa", complete("two"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    expect(get(w, a.id).status).toBe("completed");
    expect(get(w, b.id).status).toBe("completed");
    expect(w.runner.reports(a.id)).toHaveLength(1);
    expect(w.runner.reports(b.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);

    const first = w.rt.poll({ runId: "run-1" });
    expect(first.items.map((i) => i.assignmentId).sort()).toEqual([a.id, b.id].sort());
    expect(first.items.every((i) => i.kind === "settled")).toBe(true);
    expect(first.assignments.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    const second = w.rt.poll({ runId: "run-1" });
    expect(second.items).toEqual([]);
    expect(second.assignments).toEqual([]);
    expect(w.store.inbox({ runId: "run-1" }, false).every((i) => i.deliveredAt !== undefined)).toBe(true);
    expect(w.store.inbox({ runId: "run-1" }, false)).toHaveLength(2);
    expect(w.rt.status(root.id)?.children.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    invariants(w);
  });

  it("S19 routine_run root: the same flow with origin routine", async () => {
    const w = world();
    const thread = "thread-routine";
    const owner: Owner = { botId: "chief", threadId: thread };
    const root = w.rt.begin({
      origin: { kind: "routine", source: "routine", ref: "routine-9" },
      requester: { kind: "routine_run", botId: "chief", threadId: thread, runId: "rr-1" },
      assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: thread } },
      brief: "Nightly: check the build",
      level: "auto",
    });
    expect(root.origin.kind).toBe("routine");
    const child = ok(enqueueFrom(w, root, workFor("dev", "Check the build")));
    expect(child.origin).toEqual(root.origin);
    expect(child.requester).toMatchObject({ kind: "bot_turn", botId: "chief", threadId: thread });
    w.runner.script("dev", complete("green"));
    w.runner.script("chief", complete("logged"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    expect(get(w, child.id)).toMatchObject({ status: "completed", result: "green" });
    expect(w.runner.runs(child.id)[0].input!.envelope.startsWith(ENVELOPE_MARK)).toBe(true);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((x) => x.id)).toEqual([child.id]);
    const inbox = w.store.inbox(owner, false).filter((i) => i.assignmentId === child.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].kind).toBe("settled");
    expect(inbox[0].deliveredAt).toBeDefined();
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§2 admission", () => {
  it("S20 canStart string reason: stays queued, exactly one waiting event", async () => {
    const w = world();
    const root = beginChief(w);
    w.runner.setCanStart("dev", "no free computer");
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.rt.end(root.id, { ok: true, text: "" });
    for (let i = 0; i < 3; i++) {
      w.rt.tick();
      await flush();
    }
    expect(get(w, child.id).status).toBe("queued");
    expect(w.runner.runs(child.id)).toHaveLength(0);
    expect(w.runner.callsOf("canStart", child.id).length).toBeGreaterThanOrEqual(3);
    const events = w.store.events(child.id);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("enqueued");
    expect(events[1].kind).not.toBe("started");
    expect(w.rt.liveEdges()).toEqual([expect.objectContaining({ targetBotId: "dev", state: "queued" })]);
    invariants(w);

    w.runner.setCanStart("dev", true);
    await drain(w);
    expect(get(w, child.id).status).toBe("completed");
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S21 a child addressed to the parent's own thread waits until the parent's turn ends", async () => {
    const w = world();
    const room = "room-1";
    const root = w.rt.begin({
      origin: { kind: "person", source: "chat", ref: room, quote: "Team, ship it" },
      requester: { kind: "person", threadId: room, chief: true },
      assignee: { botId: "chief", destination: { kind: "room_thread", threadId: room, groupId: "g1" } },
      brief: "Team, ship it",
      level: "auto",
    });
    const child = ok(
      enqueueFrom(w, root, { assignee: { botId: "dev", destination: { kind: "room_thread", threadId: room, groupId: "g1" } }, brief: "Dev, build it" }),
    );
    for (let i = 0; i < 3; i++) {
      w.rt.tick();
      await flush();
    }
    expect(get(w, child.id).status).toBe("queued");
    expect(w.runner.runs(child.id)).toHaveLength(0);
    invariants(w);

    w.runner.script("dev", complete("built in the room"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(get(w, child.id)).toMatchObject({ status: "completed", result: "built in the room" });
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§7 invariants", () => {
  it("S22 I7: replaying a row's events yields its status", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    const refusedAtDispatch = ok(enqueueFrom(w, root, workFor("ops", "Deploy")));
    w.runner.validateReasons.set(refusedAtDispatch.id, "ops has no computer");
    const failing = ok(enqueueFrom(w, root, workFor("ops", "Flaky deploy")));
    w.runner.script(failing.id, fail("provider_error", "boom"));
    w.runner.script("dev", handOut([workFor("qa", "Test")], complete("built")), complete("verified"));
    w.runner.script("qa", needsInput("Which browser?"), complete("tested"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    const grand = w.store.children(child.id)[0];
    expect(get(w, grand.id).status).toBe("needs_input");

    const snapshotStatuses = () => {
      const seen = new Map<string, Status[]>();
      for (const call of w.runner.callsOf("changed")) {
        for (const row of call.rows ?? []) {
          const list = seen.get(row.id) ?? [];
          if (list[list.length - 1] !== row.status) list.push(row.status);
          seen.set(row.id, list);
        }
      }
      return seen;
    };

    for (const row of w.store.all()) {
      const events = w.store.events(row.id);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].kind).toBe("enqueued");
      expect(replayStatus(events)).toBe(row.status);
    }

    expect(w.rt.answer(grand.id, "firefox")).toBe(true);
    await drain(w);
    expect(get(w, root.id).status).toBe("completed");
    expect(get(w, refusedAtDispatch.id)).toMatchObject({ status: "failed", outcome: "refused" });
    expect(get(w, failing.id)).toMatchObject({ status: "failed", outcome: "provider_error" });

    const seen = snapshotStatuses();
    for (const row of w.store.all()) {
      const events = w.store.events(row.id);
      expect(replayStatus(events)).toBe(row.status);
      const ats = events.map((e) => e.at);
      expect(ats).toEqual(ats.toSorted((x, y) => x - y));
      const transitions = seen.get(row.id) ?? [];
      expect(events.length).toBeGreaterThanOrEqual(transitions.length);
    }
    invariants(w);
  });
});

describe("§8 ports", () => {
  it("S23 write-before-act: the row reads running before run(); a throwing run leaves a failed row, never a throw out of tick()", async () => {
    const w = world();
    const root = beginChief(w);
    const broken = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    const fine = ok(enqueueFrom(w, root, workFor("qa", "Test")));
    w.runner.throwOnce("run");
    w.runner.script("qa", complete("tested"));
    w.rt.end(root.id, { ok: true, text: "" });
    expect(() => w.rt.tick()).not.toThrow();
    await drain(w);

    const runs = w.runner.runs();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const call of runs) expect(call.storedStatus).toBe("running");
    const b = get(w, broken.id);
    expect(b.status).toBe("failed");
    expect(b.outcome).toBeDefined();
    expect(kinds(w, broken.id)).toContain("settled");
    expect(w.runner.reports(broken.id)).toHaveLength(1);
    expect(get(w, fine.id)).toMatchObject({ status: "completed", result: "tested" });
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)[0].input!.settled?.map((x) => x.id).sort()).toEqual([broken.id, fine.id].sort());
    expect(get(w, root.id).status).toBe("completed");
    expect(w.logs.length).toBeGreaterThan(0);
    invariants(w);
  });

  it("S23b a run() that rejects leaves a failed row with an event", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.rejectRunOnce();
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    const c = get(w, child.id);
    expect(c.status).toBe("failed");
    expect(kinds(w, child.id)).toContain("settled");
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S23c a host method that throws is read as not now and retried next tick", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.throwOnce("canStart");
    w.rt.end(root.id, { ok: true, text: "" });
    expect(() => w.rt.tick()).not.toThrow();
    await flush();
    expect(get(w, child.id).status).toBe("queued");
    expect(w.runner.runs(child.id)).toHaveLength(0);
    invariants(w);
    await drain(w);
    expect(get(w, child.id).status).toBe("completed");
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S23d a validate refusal at dispatch ends the row failed(refused), reported, never run", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.validateReasons.set("dev", "dev was deleted");
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id)).toMatchObject({ status: "failed", outcome: "refused" });
    expect(kinds(w, child.id)).toContain("refused");
    expect(w.runner.runs(child.id)).toHaveLength(0);
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§1 storage", () => {
  it("S24 prune removes old terminal trees only", async () => {
    const w = world({ queueMs: 1e12, stallMs: 1e12, turnStallMs: 1e12, inputWaitMs: 1e12 });
    const t0 = w.clock.now();

    const old = beginChief(w);
    const oldChild = ok(enqueueFrom(w, old, workFor("dev", "Old work")));
    w.rt.end(old.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, old.id).status).toBe("completed");

    const live = w.rt.begin({
      origin: { kind: "person", source: "chat", ref: "thread-live", quote: "Keep going" },
      requester: { kind: "person", threadId: "thread-live" },
      assignee: { botId: "qa", destination: { kind: "standing_thread", threadId: "thread-live" } },
      brief: "Keep going",
      level: "ask",
    });
    const liveChild = ok(enqueueFrom(w, live, workFor("dev", "Live work")));
    w.runner.script("dev", hang());
    await drain(w);
    expect(get(w, liveChild.id).status).toBe("running");

    w.clock.advance(24 * 60 * 60_000);
    const recent = w.rt.begin({
      origin: { kind: "person", source: "chat", ref: "thread-recent", quote: "Recent" },
      requester: { kind: "person", threadId: "thread-recent" },
      assignee: { botId: "ops", destination: { kind: "standing_thread", threadId: "thread-recent" } },
      brief: "Recent",
      level: "ask",
    });
    w.rt.end(recent.id, { ok: true, text: "done alone" });
    await drain(w);
    expect(get(w, recent.id).status).toBe("completed");
    expect(w.store.all()).toHaveLength(5);

    const removed = w.store.prune(t0 + 60 * 60_000);
    expect(removed).toBe(2);
    expect(w.store.get(old.id)).toBeUndefined();
    expect(w.store.get(oldChild.id)).toBeUndefined();
    expect(w.store.events(old.id)).toEqual([]);
    expect(w.store.events(oldChild.id)).toEqual([]);
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    expect(w.store.get(live.id)?.status).toBe("running");
    expect(w.store.get(liveChild.id)?.status).toBe("running");
    expect(w.store.get(recent.id)?.status).toBe("completed");
    expect(w.store.all()).toHaveLength(3);
    invariants(w);

    expect(w.store.prune(w.clock.now() + 1)).toBe(1);
    expect(w.store.get(recent.id)).toBeUndefined();
    expect(w.store.all()).toHaveLength(2);
    expect(w.store.prune(w.clock.now() + 1)).toBe(0);
    invariants(w);
  });
});

describe("§3 one level rule", () => {
  it("S25 a Chief at full with a person origin lifts the child to full on every engine; outside lineage inherits nothing", async () => {
    const w = world();
    const root = beginChief(w, { level: "full" });
    const lifted = ok(enqueueFrom(w, root, workFor("dev", "Build", { levels: { own: "ask", chief: "full" }, driverKind: "claudeAgent" })));
    expect(lifted.level).toBe("full");
    expect(lifted.levelSource).toBe("chief");
    const anyEngine = ok(enqueueFrom(w, root, workFor("qa", "Test", { levels: { own: "ask", chief: "full" }, driverKind: "unknownAgent" })));
    expect(anyEngine.level).toBe("full");
    expect(anyEngine.levelSource).toBe("chief");
    const edits = ok(enqueueFrom(w, root, workFor("ops", "Deploy", { levels: { own: "ask", chief: "auto" }, driverKind: "geminiAgent" })));
    expect(edits.level).toBe("edits");
    expect(edits.levelSource).toBe("engine_cap");
    const ownWins = ok(enqueueFrom(w, root, workFor("dev", "Lint", { levels: { own: "full", chief: "edits" }, driverKind: "claudeAgent" })));
    expect(ownWins.level).toBe("full");
    expect(ownWins.levelSource).toBe("own");
    const customNeverTravels = ok(enqueueFrom(w, root, workFor("dev", "Shell", { levels: { own: "ask", chief: "custom" }, driverKind: "codex" })));
    expect(customNeverTravels.level).toBe("ask");

    const outsideRoot = w.rt.begin({
      origin: { kind: "outside", source: "webhook", ref: "hook-1" },
      requester: { kind: "person", threadId: "thread-hook", chief: true },
      assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "thread-hook" } },
      brief: "Webhook: deploy",
      level: "full",
    });
    const outside = ok(enqueueFrom(w, outsideRoot, workFor("dev", "Deploy", { levels: { own: "ask", chief: "full" }, driverKind: "claudeAgent" })));
    expect(outside.level).toBe("ask");
    expect(outside.levelSource).toBe("own");

    w.rt.end(root.id, { ok: true, text: "" });
    w.rt.end(outsideRoot.id, { ok: true, text: "" });
    await drain(w);

    for (const call of w.runner.runs()) expect(call.input!.level).toBe(get(w, call.id!).level);
    expect(w.runner.runs(lifted.id)[0].input!.level).toBe("full");
    expect(w.runner.runs(outside.id)[0].input!.level).toBe("ask");
    expect(get(w, root.id).status).toBe("completed");
    expect(get(w, outsideRoot.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§5/§2 ported from the delegation ledger", () => {
  it("S26 downtime is nobody's budget: a queued row older than queueMs at reopen is not expired; its window restarts at boot", async () => {
    const w = world({ queueMs: 1_000, stallMs: 1e9 });
    const root = beginChief(w);
    w.runner.setCanStart("dev", false);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Leftover")));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("queued");

    w.clock.advance(5_000);
    reopen(w);
    await drain(w);
    expect(get(w, child.id).status).toBe("queued");
    expect(get(w, child.id).outcome).toBeUndefined();
    invariants(w);

    w.clock.advance(999);
    await drain(w);
    expect(get(w, child.id).status).toBe("queued");
    w.runner.setCanStart("dev", true);
    w.runner.script("dev", complete("done on Monday"));
    await drain(w);
    expect(get(w, child.id)).toMatchObject({ status: "completed", outcome: "done", result: "done on Monday" });
    expect(w.runner.runs(child.id)).toHaveLength(1);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("S27 an external runtime's failed and expired children land in its inbox and never run the requester", async () => {
    const w = world({ queueMs: 1_000, stallMs: 1e9 });
    const ext: Requester = { kind: "external_runtime", runId: "run-ext" };
    const root = w.rt.begin({
      origin: { kind: "outside", source: "external_runtime", ref: "run-ext" },
      requester: ext,
      assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "ext-thread" } },
      brief: "Two hand-offs",
      level: "ask",
      reply: "poll",
    });
    const broken = ok(enqueueFrom(w, root, workFor("dev", "Never works", { requester: ext, reply: "poll" })));
    const stuck = ok(enqueueFrom(w, root, workFor("qa", "Never starts", { requester: ext, reply: "poll" })));
    w.runner.script("dev", fail("provider_error", "no such engine"));
    w.runner.setCanStart("qa", false);
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, broken.id)).toMatchObject({ status: "failed", outcome: "provider_error", result: "no such engine" });
    expect(get(w, stuck.id).status).toBe("queued");
    expect(get(w, root.id).status).toBe("waiting");

    w.clock.advance(1_001);
    await drain(w);
    expect(get(w, stuck.id)).toMatchObject({ status: "failed", outcome: "expired" });
    expect(w.runner.runs(stuck.id)).toHaveLength(0);
    expect(w.runner.reports(broken.id)).toHaveLength(1);
    expect(w.runner.reports(stuck.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);

    const polled = w.rt.poll({ runId: "run-ext" });
    expect(polled.items.map((i) => [i.assignmentId, i.kind]).sort()).toEqual([[broken.id, "settled"], [stuck.id, "settled"]].sort());
    expect(polled.assignments.map((a) => [a.id, a.outcome]).sort()).toEqual([[broken.id, "provider_error"], [stuck.id, "expired"]].sort());
    expect(w.rt.poll({ runId: "run-ext" }).items).toEqual([]);
    expect(w.rt.status(root.id)?.children.map((c) => c.status)).toEqual(["failed", "failed"]);
    invariants(w);
  });

  it("S28 a one-way notice outlives its sender's turn that ended failed: the sender settles, the notice still runs and reports", async () => {
    const w = world();
    const root = beginChief(w);
    const notice = ok(enqueueFrom(w, root, workFor("dev", "FYI: the build is red", { mode: "notify", reply: "none" })));
    w.runner.script("dev", hang());
    w.rt.end(root.id, { ok: false, text: "the chief's turn crashed" });
    await drain(w);
    expect(get(w, root.id)).toMatchObject({ status: "failed", outcome: "provider_error" });
    expect(get(w, notice.id).status).toBe("running");
    expect(w.runner.running.has(notice.id)).toBe(true);
    expect(w.runner.runs(notice.id)[0].signal!.aborted).toBe(false);
    invariants(w);

    w.runner.release(notice.id, complete("noted"));
    await drain(w);
    expect(get(w, notice.id)).toMatchObject({ status: "completed", outcome: "done", result: "noted" });
    expect(w.runner.reports(notice.id)).toHaveLength(1);
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(get(w, root.id).status).toBe("failed");
    expect(w.store.all({ nonTerminal: true })).toEqual([]);
    invariants(w);
  });

  it("S29 two hand-offs addressed to one thread run one after the other, and the requester resumes once with both", async () => {
    const w = world();
    const root = beginChief(w);
    const devThread: Assignee = { botId: "dev", destination: { kind: "work_thread", threadId: "work-dev-shared" } };
    const first = ok(enqueueFrom(w, root, { assignee: devThread, brief: "First" }));
    const second = ok(enqueueFrom(w, root, { assignee: devThread, brief: "Second" }));
    w.runner.script("dev", hang(), complete("second done"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, first.id).status).toBe("running");
    expect(get(w, second.id).status).toBe("queued");
    expect(w.runner.runs(second.id)).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
      w.rt.tick();
      await flush();
    }
    expect(w.runner.runs(second.id)).toHaveLength(0);
    expect(get(w, root.id).status).toBe("waiting");
    invariants(w);

    w.runner.release(first.id, complete("first done"));
    await drain(w);
    expect(get(w, first.id)).toMatchObject({ status: "completed", result: "first done" });
    expect(get(w, second.id)).toMatchObject({ status: "completed", result: "second done" });
    expect(w.runner.runs(second.id)).toHaveLength(1);
    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((a) => a.id).sort()).toEqual([first.id, second.id].sort());
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });
});

describe("§2/§5 every turn a root", () => {
  const CARDS = ["msg-connector-1", "msg-secret-2"];
  const CONNECTED = "OpenMausBot connection update: the user securely connected GitHub. Continue the task.";

  it("R-S1 a root ended on cards parks; answer(id) runs it again as the answered turn, cards cleared at dispatch", async () => {
    const w = world();
    const root = beginChief(w);
    w.runner.script(root.id, complete("connected and shipped"));
    w.rt.end(root.id, { ok: true, text: "Please connect GitHub.", needsInput: { question: "Connect GitHub to continue", cards: CARDS } });

    const parked = get(w, root.id);
    expect(parked.status).toBe("needs_input");
    expect(parked.question).toBe("Connect GitHub to continue");
    expect(parked.cards).toEqual(CARDS);
    expect(parked.executions).toBe(1);
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "parked"]);
    expect(w.runner.parks(root.id)).toHaveLength(1);
    expect(w.runner.parks(root.id)[0].a!.cards).toEqual(CARDS);
    expect(w.runner.parked.has(root.id)).toBe(true);
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    expect(w.runner.reports(root.id)).toHaveLength(0);
    invariants(w);

    w.clock.advance(60 * 60_000);
    await drain(w);
    expect(get(w, root.id).status).toBe("needs_input");
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(w.runner.parks(root.id)).toHaveLength(1);

    expect(w.rt.answer(root.id, CONNECTED)).toBe(true);
    const answered = get(w, root.id);
    expect(answered.status).toBe("queued");
    expect(answered.answer).toBe(CONNECTED);
    expect(answered.question).toBeUndefined();
    expect(answered.cards).toEqual(CARDS);
    expect(kinds(w, root.id)).toContain("answered");
    expect(w.rt.answer(root.id, "again")).toBe(false);
    invariants(w);

    await drain(w);
    const runs = w.runner.runs(root.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].input!.turn).toBe("answered");
    expect(runs[0].input!.resumed).toBe(true);
    expect(runs[0].input!.answer).toBe(CONNECTED);
    expect(runs[0].input!.restartNote).toBe("");
    expect(runs[0].input!.continuation).toBeUndefined();
    expect(runs[0].a!.cards).toBeUndefined();
    expect(runs[0].a!.answer).toBe(CONNECTED);
    expect(runs[0].storedStatus).toBe("running");
    const done = get(w, root.id);
    expect(done).toMatchObject({ status: "completed", outcome: "done", result: "connected and shipped", executions: 2 });
    expect(done.cards).toBeUndefined();
    expect(done.answer).toBeUndefined();
    expect(done.reportedAt).toBeDefined();
    expect(w.runner.reports(root.id)).toHaveLength(0);
    expect(w.runner.parked.size).toBe(0);
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "parked", "answered", "admitted", "started", "settled", "reported"]);
    invariants(w);
  });

  it("R-S1b a root parked on cards keeps its parked turn's evidence, and park() shows the question once", async () => {
    const w = world();
    const root = beginChief(w);
    w.rt.end(root.id, { ok: true, text: "", evidence: { commands: 3, toolCalls: 7 }, needsInput: { question: "Approve the key", cards: ["msg-1"] } });
    expect(get(w, root.id).evidence).toEqual({ commands: 3, toolCalls: 7 });
    expect(w.runner.parks(root.id).map((p) => p.question)).toEqual(["Approve the key"]);
    await drain(w);
    expect(w.runner.parks(root.id)).toHaveLength(1);
    invariants(w);
  });

  it("R-S2 a root ended with continue is queued (continued), redispatched as the continued turn with the note and the handoff path, counted in executions; a second continue works", async () => {
    const w = world({ executions: 3 });
    const root = beginChief(w);
    w.runner.script(root.id, continueTurn("more done", "The step cap was reached again.", "/handoffs/turn-2.md"), complete("finished"));
    w.rt.end(root.id, { ok: true, text: "half done", continue: { note: "The step cap was reached.", handoffPath: "/handoffs/turn-1.md" } });

    const queued = get(w, root.id);
    expect(queued.status).toBe("queued");
    expect(queued.result).toBe("half done");
    expect(queued.continuation).toEqual({ note: "The step cap was reached.", handoffPath: "/handoffs/turn-1.md", count: 1 });
    expect(queued.executions).toBe(1);
    expect(queued.budgets?.executions).toBe(1);
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "continued"]);
    expect(w.store.events(root.id).at(-1)?.detail).toBe("queued: The step cap was reached.");
    expect(w.runner.parks(root.id)).toHaveLength(0);
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    invariants(w);

    await drain(w);
    const runs = w.runner.runs(root.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].input!.turn).toBe("continued");
    expect(runs[0].input!.resumed).toBe(true);
    expect(runs[0].input!.restartNote).toBe("");
    expect(runs[0].input!.answer).toBeUndefined();
    expect(runs[0].input!.continuation).toEqual({ note: "The step cap was reached.", handoffPath: "/handoffs/turn-1.md" });
    expect(runs[0].a!.continuation).toBeUndefined();
    expect(runs[0].a!.executions).toBe(2);
    expect(runs[1].input!.turn).toBe("continued");
    expect(runs[1].input!.continuation).toEqual({ note: "The step cap was reached again.", handoffPath: "/handoffs/turn-2.md" });
    expect(runs[1].a!.executions).toBe(3);
    const done = get(w, root.id);
    expect(done).toMatchObject({ status: "completed", outcome: "done", result: "finished", executions: 3 });
    expect(done.continuation).toBeUndefined();
    expect(done.reportedAt).toBeDefined();
    expect(w.runner.reports(root.id)).toHaveLength(0);
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "continued", "admitted", "started", "continued", "admitted", "started", "settled", "reported"]);
    expect(w.store.events(root.id).filter((e) => e.kind === "continued")).toHaveLength(2);
    invariants(w);
  });

  it("R-S2b continuations are bounded by the root's executions budget: exhaustion is failed(budget), reported once into its own conversation", async () => {
    const w = world({ executions: 2 });
    const root = beginChief(w);
    w.runner.script(root.id, continueTurn("still going", "Cap again."), complete("never"));
    w.rt.end(root.id, { ok: true, text: "half", continue: { note: "Cap." } });
    await drain(w);

    expect(w.runner.runs(root.id)).toHaveLength(1);
    const failed = get(w, root.id);
    expect(failed).toMatchObject({ status: "failed", outcome: "budget", executions: 2 });
    expect(failed.outcomeDetail).toBe("2 turns without progress");
    expect(failed.continuation).toEqual({ note: "Cap again.", count: 2 });
    expect(w.runner.reports(root.id)).toHaveLength(1);
    expect(w.runner.reports(root.id)[0].parent).toBeUndefined();
    expect(failed.reportedAt).toBeDefined();
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "continued", "admitted", "started", "continued", "settled", "reported"]);
    invariants(w);

    const w2 = world({ executions: 2 });
    const root2 = beginChief(w2);
    const child = ok(enqueueFrom(w2, root2, workFor("dev", "Build")));
    w2.runner.script("dev", complete("built"));
    w2.runner.script(root2.id, continueTurn("reviewing", "Cap."), complete("reviewed"));
    w2.rt.end(root2.id, { ok: true, text: "" });
    await drain(w2);
    expect(get(w2, child.id).status).toBe("completed");
    expect(get(w2, root2.id)).toMatchObject({ status: "completed", result: "reviewed", executions: 3 });
    invariants(w2);
  });

  it("R-S2c a child's cap continues in place: no report, no wake, the requester resumes once with the final result", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build the thing")));
    w.runner.script("dev", continueTurn("half built", "Step cap: 64 rounds.", "/handoffs/dev-1.md"), complete("built"));
    w.runner.script("chief", complete("reviewed"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);

    const runs = w.runner.runs(child.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].input!.turn).toBe("first");
    expect(runs[1].input!.turn).toBe("continued");
    expect(runs[1].input!.continuation).toEqual({ note: "Step cap: 64 rounds.", handoffPath: "/handoffs/dev-1.md" });
    expect(runs[1].input!.envelope.startsWith(ENVELOPE_MARK)).toBe(true);
    expect(get(w, child.id)).toMatchObject({ status: "completed", result: "built", executions: 2 });
    expect(w.runner.reports(child.id)).toHaveLength(1);
    expect(w.store.inbox(chiefOwner, false).map((i) => i.kind)).toEqual(["settled"]);
    expect(kinds(w, child.id)).toEqual(["enqueued", "admitted", "started", "continued", "admitted", "started", "settled", "reported", "woken"]);
    const rootRuns = w.runner.runs(root.id);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0].input!.settled?.map((a) => [a.id, a.result])).toEqual([[child.id, "built"]]);
    expect(get(w, root.id)).toMatchObject({ status: "completed", result: "reviewed" });
    invariants(w);
  });

  it("R-S3 restart: a parked root is re-parked with its cards and no new item; a cut root reruns once and ends interrupted on a second cut", async () => {
    const w = world();
    const root = beginChief(w);
    w.rt.end(root.id, { ok: true, text: "", needsInput: { question: "Connect GitHub", cards: CARDS } });
    expect(w.runner.parks(root.id)).toHaveLength(1);
    reopen(w);
    const reparked = get(w, root.id);
    expect(reparked.status).toBe("needs_input");
    expect(reparked.cards).toEqual(CARDS);
    expect(reparked.restarts).toBe(0);
    expect(reparked.restart).toBeUndefined();
    expect(w.runner.parks(root.id)).toHaveLength(2);
    expect(w.runner.parks(root.id)[1].question).toBe("Connect GitHub");
    expect(w.runner.parks(root.id)[1].a!.cards).toEqual(CARDS);
    expect(w.runner.parked.has(root.id)).toBe(true);
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    expect(w.store.events(root.id).at(-1)).toMatchObject({ kind: "restart_reconciled", detail: "needs_input: parked again" });
    await drain(w);
    expect(get(w, root.id).status).toBe("needs_input");
    expect(w.runner.runs(root.id)).toHaveLength(0);
    invariants(w);
    w.runner.script(root.id, complete("connected"));
    expect(w.rt.answer(root.id, CONNECTED)).toBe(true);
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)[0].input).toMatchObject({ turn: "answered", answer: CONNECTED, restartNote: "" });
    expect(get(w, root.id)).toMatchObject({ status: "completed", result: "connected", executions: 2, restarts: 0 });
    invariants(w);

    const v = world();
    const cut = beginChief(v);
    v.runner.script(cut.id, hang());
    reopen(v);
    const rerun = get(v, cut.id);
    expect(rerun).toMatchObject({ status: "queued", restart: "rerun", restarts: 1, executions: 1 });
    expect(v.store.events(cut.id).at(-1)).toMatchObject({ kind: "restart_reconciled", detail: "queued: rerun 1" });
    invariants(v);
    await drain(v);
    const runs = v.runner.runs(cut.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].input!.turn).toBe("rerun");
    expect(runs[0].input!.resumed).toBe(true);
    expect(runs[0].input!.restartNote).toMatch(/^OpenMausBot restarted while your previous turn here was running and cut it off;/);
    expect(runs[0].input!.restartNote).toContain("so nothing is done twice");
    expect(runs[0].a!.restart).toBe("rerun");
    expect(get(v, cut.id)).toMatchObject({ status: "running", executions: 2, restarts: 1 });
    expect(v.runner.hungIds()).toEqual([cut.id]);
    invariants(v);

    reopen(v);
    await drain(v);
    const ended = get(v, cut.id);
    expect(ended).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 1, executions: 2, result: CUT_TWICE });
    expect(ended.restart).toBeUndefined();
    expect(v.runner.runs(cut.id)).toHaveLength(1);
    expect(v.runner.reports(cut.id)).toHaveLength(1);
    expect(v.runner.reports(cut.id)[0].parent).toBeUndefined();
    expect(ended.reportedAt).toBeDefined();
    expect(v.store.inbox(chiefOwner, false)).toEqual([]);
    invariants(v);
  });

  it("R-S3b a root continued in place and then cut is dispatched normally after the restart, still as the continued turn", async () => {
    const w = world();
    const root = beginChief(w);
    w.rt.end(root.id, { ok: true, text: "half", continue: { note: "Cap.", handoffPath: "/h/1.md" } });
    expect(get(w, root.id).status).toBe("queued");
    reopen(w);
    expect(get(w, root.id)).toMatchObject({ status: "queued", restarts: 0, continuation: { note: "Cap.", handoffPath: "/h/1.md", count: 1 } });
    expect(get(w, root.id).restart).toBeUndefined();
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)[0].input).toMatchObject({ turn: "continued", restartNote: "", continuation: { note: "Cap.", handoffPath: "/h/1.md" } });
    expect(get(w, root.id)).toMatchObject({ status: "completed", executions: 2 });
    invariants(w);
  });

  it("R-S4 answer() on a root that is not parked is false; a root parked on cards never expires; a child's NEEDS INPUT park still does", async () => {
    const w = world({ inputWaitMs: 1_000 });
    const running = beginChief(w);
    expect(w.rt.answer(running.id, "typed while running")).toBe(false);
    expect(get(w, running.id).status).toBe("running");
    expect(kinds(w, running.id)).not.toContain("answered");

    const child = ok(enqueueFrom(w, running, workFor("dev", "Pick a colour")));
    w.runner.script("dev", needsInput("Which colour?"), complete("never"));
    w.rt.end(running.id, { ok: true, text: "", needsInput: { question: "Connect GitHub", cards: ["msg-1"] } });
    await drain(w);
    expect(get(w, running.id).status).toBe("needs_input");
    expect(get(w, child.id).status).toBe("needs_input");
    invariants(w);

    w.clock.advance(10 * 24 * 60 * 60_000);
    await drain(w);
    expect(get(w, child.id)).toMatchObject({ status: "failed", outcome: "expired" });
    expect(get(w, running.id).status).toBe("needs_input");
    expect(get(w, running.id).cards).toEqual(["msg-1"]);
    expect(w.rt.answer(child.id, "too late")).toBe(false);
    expect(w.runner.runs(running.id)).toHaveLength(0);
    invariants(w);

    w.runner.script(running.id, complete("late but done"));
    expect(w.rt.answer(running.id, CONNECTED)).toBe(true);
    await drain(w);
    const run = w.runner.runs(running.id);
    expect(run).toHaveLength(1);
    expect(run[0].input!.turn).toBe("answered");
    expect(run[0].input!.settled?.map((a) => [a.id, a.outcome])).toEqual([[child.id, "expired"]]);
    expect(get(w, running.id)).toMatchObject({ status: "completed", result: "late but done" });
    invariants(w);
  });

  it("R-S4b a non-finite inputWaitMs means a wait on the person never runs out, cards or not", async () => {
    const w = world({ inputWaitMs: Number.POSITIVE_INFINITY });
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Pick a colour")));
    w.runner.script("dev", needsInput("Which colour?"), complete("blue"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");
    w.clock.advance(365 * 24 * 60 * 60_000);
    await drain(w);
    expect(get(w, child.id).status).toBe("needs_input");
    expect(get(w, root.id).status).toBe("waiting");
    invariants(w);
    expect(w.rt.answer(child.id, "blue")).toBe(true);
    await drain(w);
    expect(get(w, child.id)).toMatchObject({ status: "completed", result: "blue" });
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("R-S4c a root's cards stay on the row at close and open, and a stop while parked ends it stopped with the cards gone", async () => {
    const w = world();
    const root = beginChief(w);
    w.rt.end(root.id, { ok: true, text: "", needsInput: { question: "Connect GitHub", cards: CARDS } });
    reopen(w);
    expect(get(w, root.id).cards).toEqual(CARDS);
    w.rt.cancel(root.id, "Stopped by user");
    const stopped = get(w, root.id);
    expect(stopped).toMatchObject({ status: "cancelled", outcome: "stopped" });
    expect(stopped.question).toBeUndefined();
    expect(w.rt.answer(root.id, CONNECTED)).toBe(false);
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(w.runner.reports(root.id)).toHaveLength(1);
    invariants(w);
  });

  it("R-S5 prune(before) removes only terminal trees older than before, never a tree with a non-terminal node", async () => {
    const w = world({ queueMs: 1e12, stallMs: 1e12, turnStallMs: 1e12 });
    const t0 = w.clock.now();
    const done = beginChief(w);
    const doneChild = ok(enqueueFrom(w, done, workFor("dev", "Old work")));
    w.rt.end(done.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, done.id).status).toBe("completed");
    const parked = w.rt.begin({ origin: { kind: "person", source: "chat", ref: "thread-parked", quote: "Connect" },
      requester: { kind: "person", threadId: "thread-parked" }, assignee: { botId: "qa", destination: { kind: "standing_thread", threadId: "thread-parked" } },
      brief: "Connect", level: "ask" });
    w.rt.end(parked.id, { ok: true, text: "", needsInput: { question: "Connect GitHub", cards: ["msg-1"] } });
    const half = w.rt.begin({ origin: { kind: "person", source: "chat", ref: "thread-half", quote: "Half" },
      requester: { kind: "person", threadId: "thread-half" }, assignee: { botId: "ops", destination: { kind: "standing_thread", threadId: "thread-half" } },
      brief: "Half", level: "ask" });
    const halfChild = ok(enqueueFrom(w, half, { assignee: { botId: "dev", destination: { kind: "work_thread", threadId: "work-dev-half" } }, brief: "Keep running", reply: "none" }));
    w.runner.script(halfChild.id, hang());
    w.rt.end(half.id, { ok: true, text: "done alone" });
    await drain(w);
    expect(get(w, half.id).status).toBe("completed");
    expect(get(w, halfChild.id).status).toBe("running");
    w.clock.advance(31 * 24 * 60 * 60_000);
    const recent = w.rt.begin({ origin: { kind: "person", source: "chat", ref: "thread-recent", quote: "Recent" },
      requester: { kind: "person", threadId: "thread-recent" }, assignee: { botId: "ops", destination: { kind: "standing_thread", threadId: "thread-recent" } },
      brief: "Recent", level: "ask" });
    w.rt.end(recent.id, { ok: true, text: "quick" });
    expect(w.store.all()).toHaveLength(6);

    expect(w.rt.prune(t0 + 30 * 24 * 60 * 60_000)).toBe(2);
    expect(w.store.get(done.id)).toBeUndefined();
    expect(w.store.get(doneChild.id)).toBeUndefined();
    expect(w.store.get(parked.id)?.status).toBe("needs_input");
    expect(w.store.get(parked.id)?.cards).toEqual(["msg-1"]);
    expect(w.store.get(half.id)?.status).toBe("completed");
    expect(w.store.get(halfChild.id)?.status).toBe("running");
    expect(w.store.get(recent.id)?.status).toBe("completed");
    expect(w.rt.prune(t0 + 30 * 24 * 60 * 60_000)).toBe(0);
    invariants(w);
    expect(w.rt.answer(parked.id, CONNECTED)).toBe(true);
    await drain(w);
    expect(get(w, parked.id).status).toBe("completed");
    invariants(w);
  });

  it("R-S6 I7: a root's continued, parked and answered events replay to its status at every step", async () => {
    const w = world();
    const root = beginChief(w);
    const check = () => { for (const row of w.store.all()) expect(replayStatus(w.store.events(row.id))).toBe(row.status); };
    w.rt.end(root.id, { ok: true, text: "half", continue: { note: "Cap." } });
    expect(replayStatus(w.store.events(root.id))).toBe("queued");
    check();
    w.runner.script(root.id, needsInput("Connect GitHub", ["msg-1"]), complete("done"));
    await drain(w);
    expect(get(w, root.id).status).toBe("needs_input");
    expect(replayStatus(w.store.events(root.id))).toBe("needs_input");
    check();
    reopen(w);
    check();
    expect(w.rt.answer(root.id, CONNECTED)).toBe(true);
    expect(replayStatus(w.store.events(root.id))).toBe("queued");
    check();
    await drain(w);
    expect(get(w, root.id)).toMatchObject({ status: "completed", executions: 3 });
    check();
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "continued", "admitted", "started", "parked", "restart_reconciled", "answered", "admitted", "started", "settled", "reported"]);
    invariants(w);
  });

  it("R-S7 end() never throws: an unknown id, a child, a root that is not running are logged and left alone", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.script("dev", hang());
    expect(() => w.rt.end("no-such-root", { ok: true, text: "" })).not.toThrow();
    expect(() => w.rt.end(child.id, { ok: true, text: "" })).not.toThrow();
    expect(get(w, child.id).status).toBe("queued");
    w.rt.end(root.id, { ok: true, text: "" });
    expect(get(w, root.id).status).toBe("waiting");
    expect(() => w.rt.end(root.id, { ok: false, text: "again" })).not.toThrow();
    expect(get(w, root.id).status).toBe("waiting");
    await drain(w);
    expect(get(w, child.id).status).toBe("running");
    expect(() => w.rt.end(child.id, { ok: true, text: "" })).not.toThrow();
    expect(get(w, child.id).status).toBe("running");
    expect(w.logs.filter((line) => /not a running root/.test(line))).toHaveLength(4);
    invariants(w);
  });
});

describe("§5 outward / §2 loop guard", () => {
  const NO_PROGRESS = { okToolCalls: 0, toolCalls: 2 };
  const PROGRESS = { okToolCalls: 3, toolCalls: 3 };
  const SAME_ERROR = "ENOENT: no such file or directory, open 'config.json'";

  it("R-S8 a cut turn whose outward list is empty reruns once in place, as before: the port is asked once per cut node", async () => {
    const w = world();
    const root = beginChief(w);
    const child = ok(enqueueFrom(w, root, workFor("dev", "Build")));
    w.runner.script("dev", hang(), complete("built"));
    w.runner.script("chief", complete("reviewed"));
    w.rt.end(root.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("running");
    w.runner.setOutward(child.id, []);

    reopen(w);
    expect(w.runner.callsOf("outward").map((c) => [c.id, c.answer])).toEqual([[child.id, []]]);
    expect(get(w, child.id)).toMatchObject({ status: "queued", restart: "rerun", restarts: 1 });
    expect(get(w, root.id)).toMatchObject({ status: "waiting", restart: "teammates" });
    invariants(w);
    await drain(w);
    const runs = w.runner.runs(child.id);
    expect(runs).toHaveLength(2);
    expect(runs[1].input!.turn).toBe("rerun");
    expect(runs[1].input!.restartNote).toMatch(/^OpenMausBot restarted while your previous turn here was running/);
    expect(get(w, child.id)).toMatchObject({ status: "completed", result: "built", restarts: 1 });
    expect(w.runner.runs(root.id)[0].input!.restartNote).toContain("Dev (resumed once in place and told to check what it had already done)");
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);
  });

  it("R-S9 a cut turn that already acted outward is not rerun: failed(interrupted) with what it did, reported; a root into its own conversation, a child to its requester with the restart note", async () => {
    const w = world();
    const root = beginChief(w);
    w.runner.setOutward(root.id, ["GMAIL_SEND_EMAIL", "git push"]);
    reopen(w);
    const ended = get(w, root.id);
    expect(ended).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 0, executions: 1 });
    expect(ended.restart).toBeUndefined();
    expect(ended.outcomeDetail).toBe(`${INTERRUPTED_OUTWARD} sent an email (GMAIL_SEND_EMAIL), pushed (git push); not resumed, so nothing is done twice.`);
    expect(ended.outcomeDetail!.startsWith("Interrupted by an OpenMausBot restart after it already")).toBe(true);
    expect(ended.result).toBe(ended.outcomeDetail);
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "restart_reconciled", "settled", "reported"]);
    expect(w.store.events(root.id).map((e) => e.detail)).toEqual(["queued: root", "running: turn 1 (host), level auto", "failed: outward action done",
      `failed: interrupted — ${ended.outcomeDetail}`, "reported"]);
    expect(w.runner.callsOf("outward").map((c) => c.id)).toEqual([root.id]);
    expect(w.runner.reports(root.id)).toHaveLength(1);
    expect(w.runner.reports(root.id)[0].parent).toBeUndefined();
    expect(w.runner.reports(root.id)[0].a!.outcomeDetail).toBe(ended.outcomeDetail);
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    invariants(w);
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(get(w, root.id).status).toBe("failed");
    invariants(w);

    const v = world();
    const vroot = beginChief(v);
    const child = ok(enqueueFrom(v, vroot, workFor("dev", "Announce the release")));
    v.runner.script("dev", hang(), complete("never"));
    v.runner.script("chief", complete("reviewed"));
    v.rt.end(vroot.id, { ok: true, text: "" });
    await drain(v);
    expect(get(v, child.id).status).toBe("running");
    v.runner.setOutward(child.id, ["SLACK_SEND_MESSAGE"]);
    reopen(v);
    const cut = get(v, child.id);
    expect(cut).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 0, executions: 1 });
    expect(cut.outcomeDetail).toBe(`${INTERRUPTED_OUTWARD} sent a message (SLACK_SEND_MESSAGE); not resumed, so nothing is done twice.`);
    expect(v.store.events(child.id).find((e) => e.kind === "restart_reconciled")?.detail).toBe("failed: outward action done");
    expect(v.runner.reports(child.id)).toHaveLength(1);
    expect(v.runner.reports(child.id)[0].parent?.id).toBe(vroot.id);
    expect(v.store.inbox(chiefOwner, false).map((i) => [i.assignmentId, i.kind])).toEqual([[child.id, "settled"]]);
    expect(get(v, vroot.id)).toMatchObject({ status: "waiting", restart: "teammates" });
    invariants(v);
    await drain(v);
    expect(v.runner.runs(child.id)).toHaveLength(1);
    const resume = v.runner.runs(vroot.id);
    expect(resume).toHaveLength(1);
    expect(resume[0].input!.turn).toBe("resume");
    expect(resume[0].input!.settled?.map((a) => [a.id, a.outcome, a.outcomeDetail])).toEqual([[child.id, "interrupted", cut.outcomeDetail]]);
    expect(resume[0].input!.restartNote).toBe("A restart cut these teammates' turns: Dev (cut after an outward action, not resumed: see its result). Check their results as usual.\n");
    expect(get(v, vroot.id)).toMatchObject({ status: "completed", result: "reviewed" });
    invariants(v);

    const u = world();
    const uroot = beginChief(u);
    const twice = ok(enqueueFrom(u, uroot, workFor("dev", "Deploy")));
    u.runner.script("dev", hang(), hang());
    u.rt.end(uroot.id, { ok: true, text: "" });
    await drain(u);
    reopen(u);
    await drain(u);
    expect(get(u, twice.id)).toMatchObject({ status: "running", restarts: 1, executions: 2 });
    u.runner.setOutward(twice.id, ["git commit", "git push"]);
    reopen(u);
    expect(get(u, twice.id)).toMatchObject({ status: "failed", outcome: "interrupted", restarts: 1, executions: 2,
      outcomeDetail: `${INTERRUPTED_OUTWARD} committed (git commit), pushed (git push); not resumed, so nothing is done twice.` });
    expect(get(u, twice.id).result).not.toBe(CUT_TWICE);
    await drain(u);
    expect(u.runner.runs(uroot.id)[0].input!.restartNote).toContain("Dev (cut after an outward action, not resumed: see its result)");
    expect(get(u, uroot.id).status).toBe("completed");
    invariants(u);
  });

  it("R-S10 a host without the port, or one that throws, reruns the cut turn as before; a turn that handed out work is never asked", async () => {
    const w = world({}, { outward: false });
    expect(w.runner.outward).toBeUndefined();
    const root = beginChief(w);
    reopen(w);
    expect(get(w, root.id)).toMatchObject({ status: "queued", restart: "rerun", restarts: 1 });
    expect(w.runner.callsOf("outward")).toEqual([]);
    await drain(w);
    expect(w.runner.runs(root.id)[0].input!.turn).toBe("rerun");
    expect(get(w, root.id).status).toBe("completed");
    invariants(w);

    // An override, not throwOnce: reboot() clears a one-shot throw.
    const v = world();
    const vroot = beginChief(v);
    v.runner.outward = () => { throw new Error("activity rows locked"); };
    reopen(v);
    expect(get(v, vroot.id)).toMatchObject({ status: "queued", restart: "rerun", restarts: 1 });
    expect(v.logs.some((line) => /outward threw/.test(line))).toBe(true);
    await drain(v);
    expect(get(v, vroot.id).status).toBe("completed");
    invariants(v);

    const u = world();
    const uroot = beginChief(u);
    const child = ok(enqueueFrom(u, uroot, workFor("dev", "Build")));
    u.runner.script("dev", hang(), complete("built"));
    u.runner.script("chief", complete("reviewed"));
    u.runner.setOutward(uroot.id, ["git push"]);
    u.rt.tick();
    await flush();
    expect(get(u, child.id).status).toBe("running");
    reopen(u);
    expect(get(u, uroot.id)).toMatchObject({ status: "waiting", restart: "cut" });
    expect(u.runner.callsOf("outward").map((c) => c.id)).toEqual([child.id]);
    await drain(u);
    expect(get(u, uroot.id).status).toBe("completed");
    invariants(u);
  });

  it("R-S11 two continuations in a row without a successful tool call stop the node: failed(stalled), reported; a child wakes its requester as stalled", async () => {
    const w = world();
    const root = beginChief(w);
    w.runner.script(root.id, continueTurn("still nothing", "The step cap was reached again.", undefined, NO_PROGRESS), complete("never"));
    w.rt.end(root.id, { ok: true, text: "nothing yet", evidence: NO_PROGRESS, continue: { note: "The step cap was reached." } });
    expect(get(w, root.id)).toMatchObject({ status: "queued", guard: { stale: 1, errors: [] } });
    invariants(w);
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    const stopped = get(w, root.id);
    expect(stopped).toMatchObject({ status: "failed", outcome: "stalled", executions: 2, result: "still nothing", guard: { stale: 2, errors: [] } });
    expect(stopped.outcomeDetail).toBe("Stopped after 2 continuations without progress: still nothing");
    expect(stopped.continuation).toBeUndefined();
    expect(kinds(w, root.id)).toEqual(["enqueued", "started", "continued", "admitted", "started", "stalled", "settled", "reported"]);
    expect(w.store.events(root.id).at(-3)?.detail).toBe("no progress: 2 continuations without a successful tool call");
    expect(w.store.events(root.id).at(-2)?.detail).toBe("failed: stalled — Stopped after 2 continuations without progress: still nothing");
    expect(replayStatus(w.store.events(root.id))).toBe("failed");
    expect(w.runner.reports(root.id)).toHaveLength(1);
    expect(w.runner.reports(root.id)[0].parent).toBeUndefined();
    expect(w.store.inbox(chiefOwner, false)).toEqual([]);
    invariants(w);

    const v = world();
    const vroot = beginChief(v);
    const child = ok(enqueueFrom(v, vroot, workFor("dev", "Build")));
    v.runner.script("dev", continueTurn("spinning", "Cap.", "/h/1.md", NO_PROGRESS), continueTurn("still spinning", "Cap.", "/h/2.md", NO_PROGRESS), complete("never"));
    v.runner.script("chief", complete("gave up"));
    v.rt.end(vroot.id, { ok: true, text: "" });
    await drain(v);
    expect(v.runner.runs(child.id)).toHaveLength(2);
    expect(get(v, child.id)).toMatchObject({ status: "failed", outcome: "stalled", result: "still spinning",
      outcomeDetail: "Stopped after 2 continuations without progress: still spinning" });
    expect(v.runner.reports(child.id)).toHaveLength(1);
    expect(v.store.inbox(chiefOwner, false).map((i) => i.kind)).toEqual(["stalled"]);
    expect(v.runner.runs(vroot.id)[0].input!.settled?.map((a) => [a.id, a.outcome])).toEqual([[child.id, "stalled"]]);
    expect(get(v, vroot.id)).toMatchObject({ status: "completed", result: "gave up" });
    invariants(v);
  });

  it("R-S12 the same error three times across continuing executions stops the node, even with ok tool calls between; three different errors do not", async () => {
    const w = world();
    const root = beginChief(w);
    w.runner.script(root.id,
      continueTurn("retrying", "Cap.", undefined, { okToolCalls: 1, errors: [SAME_ERROR] }),
      continueTurn("retrying again", "Cap.", undefined, { okToolCalls: 4, errors: [SAME_ERROR] }),
      complete("never"));
    w.rt.end(root.id, { ok: true, text: "first try", evidence: { okToolCalls: 2, errors: [SAME_ERROR] }, continue: { note: "Cap." } });
    expect(get(w, root.id).guard).toEqual({ stale: 0, errors: [SAME_ERROR] });
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(2);
    const stopped = get(w, root.id);
    expect(stopped).toMatchObject({ status: "failed", outcome: "stalled", executions: 3, result: "retrying again", guard: { stale: 0, errors: [SAME_ERROR, SAME_ERROR, SAME_ERROR] } });
    expect(stopped.outcomeDetail).toBe(`Stopped after 3 identical errors: ${SAME_ERROR}`);
    expect(w.store.events(root.id).filter((e) => e.kind === "stalled").map((e) => e.detail)).toEqual(["no progress: the same error 3 times"]);
    expect(w.runner.reports(root.id)).toHaveLength(1);
    invariants(w);

    const v = world();
    const vroot = beginChief(v);
    v.runner.script(vroot.id, continueTurn("again", "Cap.", undefined, { okToolCalls: 1, errors: [SAME_ERROR] }), complete("never"));
    v.rt.end(vroot.id, { ok: true, text: "twice", evidence: { okToolCalls: 1, errors: ["a different one", SAME_ERROR, SAME_ERROR] }, continue: { note: "Cap." } });
    await drain(v);
    expect(get(v, vroot.id)).toMatchObject({ status: "failed", outcome: "stalled", outcomeDetail: `Stopped after 3 identical errors: ${SAME_ERROR}`, executions: 2 });
    invariants(v);

    const u = world();
    const uroot = beginChief(u);
    u.runner.script(uroot.id,
      continueTurn("b", "Cap.", undefined, { okToolCalls: 1, errors: ["error B"] }),
      continueTurn("a", "Cap.", undefined, { okToolCalls: 1, errors: ["error A"] }),
      complete("done at last"));
    u.rt.end(uroot.id, { ok: true, text: "a", evidence: { okToolCalls: 1, errors: ["error A"] }, continue: { note: "Cap." } });
    await drain(u);
    expect(get(u, uroot.id)).toMatchObject({ status: "completed", result: "done at last", executions: 4 });
    expect(get(u, uroot.id).guard).toBeUndefined();
    invariants(u);
  });

  it("R-S13 a continuation that made progress resets the strike, and any other end of a turn clears the guard", async () => {
    const w = world();
    const root = beginChief(w);
    w.runner.script(root.id,
      continueTurn("made progress", "Cap.", undefined, PROGRESS),
      continueTurn("nothing this time", "Cap.", undefined, NO_PROGRESS),
      complete("finished"));
    w.rt.end(root.id, { ok: true, text: "nothing yet", evidence: NO_PROGRESS, continue: { note: "Cap." } });
    expect(get(w, root.id).guard).toEqual({ stale: 1, errors: [] });
    await drain(w);
    const done = get(w, root.id);
    expect(done).toMatchObject({ status: "completed", result: "finished", executions: 4 });
    expect(done.guard).toBeUndefined();
    expect(w.runner.runs(root.id).map((r) => r.a!.guard)).toEqual([{ stale: 1, errors: [] }, { stale: 0, errors: [] }, { stale: 1, errors: [] }]);
    expect(kinds(w, root.id)).not.toContain("stalled");
    invariants(w);

    const v = world();
    const vroot = beginChief(v);
    v.runner.script(vroot.id, needsInput("Connect GitHub", ["msg-1"]), continueTurn("after the card", "Cap.", undefined, NO_PROGRESS), complete("done"));
    v.rt.end(vroot.id, { ok: true, text: "", evidence: NO_PROGRESS, continue: { note: "Cap." } });
    await drain(v);
    expect(get(v, vroot.id)).toMatchObject({ status: "needs_input", cards: ["msg-1"] });
    expect(get(v, vroot.id).guard).toBeUndefined();
    expect(v.rt.answer(vroot.id, "The user connected GitHub.")).toBe(true);
    await drain(v);
    expect(get(v, vroot.id)).toMatchObject({ status: "completed", result: "done", executions: 4 });
    invariants(v);
  });

  it("R-S14 continuations without evidence, or whose evidence has no ok count, are not strikes: the executions budget is the backstop", async () => {
    const w = world({ executions: 4 });
    const root = beginChief(w);
    w.runner.script(root.id,
      continueTurn("two", "Cap."),
      continueTurn("three", "Cap.", undefined, { commands: 2, toolCalls: 5 }),
      continueTurn("four", "Cap."),
      complete("never"));
    w.rt.end(root.id, { ok: true, text: "one", continue: { note: "Cap." } });
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(3);
    const failed = get(w, root.id);
    expect(failed).toMatchObject({ status: "failed", outcome: "budget", executions: 4, outcomeDetail: "4 turns without progress", guard: { stale: 0, errors: [] } });
    expect(kinds(w, root.id)).not.toContain("stalled");
    expect(w.runner.reports(root.id)).toHaveLength(1);
    invariants(w);

    const v = world();
    const vroot = beginChief(v);
    v.runner.script(vroot.id, continueTurn("unknown", "Cap."), continueTurn("nothing again", "Cap.", undefined, NO_PROGRESS), complete("never"));
    v.rt.end(vroot.id, { ok: true, text: "nothing", evidence: NO_PROGRESS, continue: { note: "Cap." } });
    await drain(v);
    expect(get(v, vroot.id)).toMatchObject({ status: "failed", outcome: "stalled", executions: 3, guard: { stale: 2, errors: [] } });
    invariants(v);
  });

  it("R-S15 a queued continuation has no queue bound and no stall window: it waits for the host however long; a plain queued row still expires", async () => {
    const w = world({ queueMs: 1_000, stallMs: 60_000 });
    const root = beginChief(w);
    w.runner.setCanStart("chief", false);
    w.rt.end(root.id, { ok: true, text: "waiting for the computer", continue: { note: "The computer is taken. Continue when it is free." } });
    expect(get(w, root.id)).toMatchObject({ status: "queued", continuation: { note: "The computer is taken. Continue when it is free.", count: 1 } });
    const other = w.rt.begin({ origin: { kind: "person", source: "chat", ref: "thread-other", quote: "Other" },
      requester: { kind: "person", threadId: "thread-other" }, assignee: { botId: "ops", destination: { kind: "standing_thread", threadId: "thread-other" } },
      brief: "Other", level: "ask" });
    const child = ok(enqueueFrom(w, other, workFor("dev", "Never starts")));
    w.runner.setCanStart("dev", false);
    w.rt.end(other.id, { ok: true, text: "" });
    await drain(w);
    expect(get(w, child.id).status).toBe("queued");

    w.clock.advance(10 * 24 * 60 * 60_000);
    await drain(w);
    expect(get(w, root.id)).toMatchObject({ status: "queued", continuation: { count: 1 } });
    expect(get(w, root.id).outcome).toBeUndefined();
    expect(kinds(w, root.id)).not.toContain("stalled");
    expect(w.runner.runs(root.id)).toHaveLength(0);
    expect(get(w, child.id)).toMatchObject({ status: "failed", outcome: "expired", outcomeDetail: "never started" });
    expect(get(w, other.id)).toMatchObject({ status: "completed" });
    invariants(w);

    w.runner.setCanStart("chief", true);
    w.runner.script(root.id, complete("done on the computer"));
    await drain(w);
    expect(w.runner.runs(root.id)).toHaveLength(1);
    expect(w.runner.runs(root.id)[0].input).toMatchObject({ turn: "continued", continuation: { note: "The computer is taken. Continue when it is free." } });
    expect(get(w, root.id)).toMatchObject({ status: "completed", result: "done on the computer", executions: 2 });
    invariants(w);
  });
});
