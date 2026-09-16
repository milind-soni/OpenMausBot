import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomHandoffs, ROOM_HANDOFF_LIMITS, type RoomHandoffHooks } from "./room-handoffs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const addr = (id: string) => ({ groupId: id, threadId: `${id}-thread`, botId: `${id}-bot` });
/** Builds an engine over a temp file, with hooks and clock the test can override. */
async function fixture(test: (engine: RoomHandoffs, hooks: RoomHandoffHooks, file: string) => Promise<void> | void, now: () => number = Date.now,
  limits: Partial<typeof ROOM_HANDOFF_LIMITS> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "room-handoff-unit-"));
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: () => false,
    run: vi.fn(async () => ({ ok: true, text: "done" })), report: vi.fn(), changed: () => {} };
  try { const file = join(dir, "requests.json"); await test(new RoomHandoffs(file, hooks, now, limits), hooks, file); }
  finally { await removeTempDir(dir); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("addressed room request tree", () => {
  it("treats group-less tasks as bounded work, deduplicates pinned threads and rejects direct or mixed cycles", () => fixture(engine => {
    const source = { botId: "clive", threadId: "clive-chat" };
    const target = { botId: "lead", threadId: "lead-task" };
    const first = engine.enqueue(source, "turn", undefined, target, "build", "Build CSV").node;
    expect(first.kind).toBe("work");
    expect(engine.enqueue(source, "turn", undefined, { ...target, threadId: "changed" }, "build", "Build CSV").node.threadId).toBe("lead-task");
    expect(engine.nodes.size).toBe(2);
    expect(() => engine.enqueue(source, "turn", undefined, target, "build", "Changed work")).toThrow("different work");
    first.status = "running";
    expect(() => engine.enqueue(first, "unused", first.id, { ...source, threadId: "new-chat" }, "cycle", "repeat")).toThrow("ancestor");
    expect(() => engine.enqueue(first, "unused", first.id, { ...source, groupId: "room", threadId: "room-chat" }, "mixed", "repeat")).toThrow("ancestor");
    let parent = first;
    for (let depth = 2; depth <= ROOM_HANDOFF_LIMITS.depth; depth++) {
      parent.status = "running";
      parent = engine.enqueue(parent, "unused", parent.id, { botId: `bot-${depth}`, threadId: `task-${depth}` }, "next", "do work").node;
    }
    parent.status = "running";
    expect(() => engine.enqueue(parent, "unused", parent.id, { botId: "too-deep", threadId: "too-deep" }, "next", "do work")).toThrow("depth limit");
  }));
  it("cancels only the selected direct tree and records interruption without replay on restart", () => fixture((engine, hooks, file) => {
    const one = { botId: "clive", threadId: "one" };
    const two = { botId: "clive", threadId: "two" };
    engine.enqueue(one, "first", undefined, { botId: "lead", threadId: "lead-one" }, "work", "build");
    const other = engine.enqueue(two, "second", undefined, { botId: "lead", threadId: "lead-two" }, "work", "build").node;
    engine.cancelDirect("one");
    expect(engine.activeDirect("one")).toBe(false);
    expect(engine.activeDirect("two")).toBe(true);
    expect(other.status).toBe("queued");
    const restarted = new RoomHandoffs(file, hooks); restarted.tick();
    expect(restarted.nodes.get(other.id)?.status).toBe("failed");
    expect(restarted.nodes.get(other.id)?.result).toContain("restart");
    expect(hooks.run).not.toHaveBeenCalled();
  }));
  it("publishes only changed groups, including their final idle and cancelled states", () => fixture(async (engine, hooks) => {
    const updates: Array<{ id: string; active: boolean }[]> = [];
    hooks.changed = ids => updates.push([...ids].map(id => ({ id, active: [...engine.nodes.values()]
      .some(n => n.groupId === id && !["completed", "failed", "cancelled"].includes(n.status)) })));
    engine.enqueue(addr("Old"), "old", undefined, addr("History"), "work", "old work");
    engine.cancelRoom("Old");
    updates.length = 0;
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    // Settle retained history reports before observing the new tree alone.
    engine.tick(); updates.length = 0;
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 5; i++) { engine.tick(); await flush(); }
    expect(updates.flat().every(update => ["A", "B"].includes(update.id))).toBe(true);
    expect(updates.flat()).toContainEqual({ id: "A", active: false });
    expect(updates.flat()).toContainEqual({ id: "B", active: false });
    engine.enqueue(addr("C"), "cancel", undefined, addr("D"), "work", "cancel work");
    updates.length = 0; engine.cancelRoom("C");
    expect(updates.flat()).toEqual([{ id: "D", active: false }, { id: "C", active: false }]);
  }));
  it("splits responsibility between existing members who send their own downstream work and return to the chair", () => fixture(async (engine, hooks) => {
    const member = (id: string) => ({ ...addr("A"), botId: id });
    const order: string[] = [];
    hooks.run = async (node, resumed) => {
      order.push(`${node.botId}:${resumed}`);
      if (node.kind === "assignment" && !resumed) {
        engine.enqueue(member(node.botId), "unused", node.id, addr(node.botId === "engineer" ? "B" : "C"), "downstream", "concrete task");
      }
      return { ok: true, text: `${node.botId} done` };
    };
    engine.enqueue(addr("A"), "turn", undefined, member("engineer"), "engineering", "own engineering");
    engine.enqueue(addr("A"), "turn", undefined, member("sales"), "sales", "own sales");
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 12; i++) { engine.tick(); await flush(); }
    expect(engine.children("turn").map(n => n.botId)).toEqual(["engineer", "sales"]);
    expect(order).toContain("engineer:true"); expect(order).toContain("sales:true");
    expect(order.at(-1)).toBe("A-bot:true");
    expect([...engine.nodes.values()].every(n => n.status === "completed")).toBe(true);
  }));
  it("allows same-room consultation without a discussion ceremony, but refuses returning to an ancestor", () => fixture(engine => {
    const local = engine.enqueue(addr("A"), "turn", undefined, { ...addr("A"), botId: "owner" }, "own", "Review the plan").node;
    expect(local.kind).toBe("assignment");
    local.status = "running";
    expect(() => engine.enqueue(local, "unused", local.id, addr("A"), "loop", "task")).toThrow("ancestor");
  }));
  it("deduplicates retries, pins the destination thread, and refuses changed work", () => fixture(engine => {
    const first = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "csv", "build");
    const again = engine.enqueue(addr("A"), "turn", undefined, { ...addr("B"), threadId: "new-active" }, "csv", "build");
    expect(again.duplicate).toBe(true); expect(again.node.id).toBe(first.node.id); expect(again.node.threadId).toBe("B-thread");
    expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("B"), "csv", "different")).toThrow("different work");
  }));
  it("retains the original request while descendants work and bounds its stored length", () => fixture(engine => {
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build", false, false, "original request");
    expect(engine.nodes.get("turn")?.text).toBe("original request");
    engine.enqueue(addr("A"), "turn", undefined, addr("C"), "review", "check", false, false, "later brief");
    expect(engine.nodes.get("turn")?.text).toBe("original request");
    engine.enqueue(addr("X"), "other", undefined, addr("Y"), "work", "build", false, false, "x".repeat(20_000));
    expect(engine.nodes.get("other")?.text).toHaveLength(12_000);
  }));
  it("releases the middle turn before starting its child, then returns and resumes both ancestors", () => fixture(async (engine, hooks) => {
    const order: string[] = [];
    hooks.run = async (node, resumed) => {
      order.push(`${node.groupId}:${resumed}`);
      if (node.groupId === "B" && !resumed) engine.enqueue(addr("B"), "ignored", node.id, addr("C"), "implementation", "build CSV");
      return { ok: true, text: `${node.groupId} done` };
    };
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "develop", "build");
    engine.tick(); expect(order).toEqual([]);
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 12; i++) { engine.tick(); await flush(); }
    expect(order).toEqual(["B:false", "C:false", "B:true", "A:true"]);
    expect(engine.nodes.get("turn")?.status).toBe("completed");
    expect(hooks.report).toHaveBeenCalledTimes(2);
  }));
  it("rejects accidental acknowledgements as new work while allowing retries and explicit additional work", () => fixture(engine => {
    const completed = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build").node;
    completed.status = "completed";
    expect(engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build").duplicate).toBe(true);
    expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("B"), "ack", "approved")).toThrow("already completed");
    expect(engine.enqueue(addr("A"), "turn", undefined, addr("B"), "fix", "Fix the missing boundary case", false, true).node.status).toBe("queued");
  }));
  it("resumes the parent only after all sibling results have been delivered", () => fixture(async (engine, hooks) => {
    const delivered: string[] = [];
    let finishSlow!: (result: { ok: boolean; text: string }) => void;
    const resumed: string[][] = [];
    hooks.report = child => { delivered.push(child.groupId!); };
    hooks.run = async (node, resume) => {
      if (resume) resumed.push([...delivered]);
      if (node.groupId === "C") return new Promise(resolve => { finishSlow = resolve; });
      return { ok: true, text: `${node.groupId} done` };
    };
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "fast", "build");
    engine.enqueue(addr("A"), "turn", undefined, addr("C"), "slow", "check");
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    expect(delivered).toEqual(["B"]); expect(resumed).toEqual([]);
    finishSlow({ ok: true, text: "C done" }); await flush();
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    expect(resumed).toEqual([["B", "C"]]);
    expect(engine.nodes.get("turn")?.status).toBe("completed");
  }));
  it("blocks ancestor loops and forged parents", () => fixture(engine => {
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    node.status = "running";
    expect(() => engine.enqueue(addr("B"), "t2", node.id, addr("A"), "loop", "again")).toThrow("ancestor");
    expect(() => engine.enqueue(addr("X"), "t2", node.id, addr("C"), "spoof", "again")).toThrow("speaker");
    expect(() => engine.enqueue(addr("B"), "t2", "missing", addr("C"), "missing", "again")).toThrow("no longer running");
  }));
  it("bounds fan-out and depth across the entire root", () => fixture(engine => {
    for (let i = 0; i < ROOM_HANDOFF_LIMITS.requests; i++) engine.enqueue(addr("A"), "turn", undefined, addr(`B${i}`), `work${i}`, "build");
    expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("X"), "overflow", "build")).toThrow("budget");
    let source = addr("root2"); let parentId: string | undefined;
    for (let i = 0; i < ROOM_HANDOFF_LIMITS.depth; i++) {
      const { node } = engine.enqueue(source, "second-root", parentId, addr(`depth${i}`), "work", "build");
      node.status = "running"; source = addr(`depth${i}`); parentId = node.id;
    }
    expect(() => engine.enqueue(source, "second-root", parentId, addr("too-deep"), "work", "build")).toThrow("depth");
  }));
  it("cancels queued work when its source fails and never runs a revoked route", () => fixture(async (engine, hooks) => {
    engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    engine.sourceSettled("turn", false); engine.tick(); await flush();
    expect(hooks.run).not.toHaveBeenCalled();
    const { node } = engine.enqueue(addr("C"), "turn2", undefined, addr("D"), "work", "build");
    engine.sourceSettled("turn2", true);
    hooks.validate = n => n.id === node.id ? "route revoked" : undefined;
    engine.tick(); await flush(); expect(node.status).toBe("failed"); expect(node.result).toContain("revoked");
  }));
  it("retains busy work and aborts an executing child when the source is stopped", () => fixture(async (engine, hooks) => {
    let aborted = false;
    hooks.busy = () => true;
    hooks.run = (_n, _r, signal) => new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve({ ok: false, text: "stopped" }); }));
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    engine.sourceSettled("turn", true); engine.tick(); expect(node.status).toBe("queued");
    hooks.busy = () => false; engine.tick(); expect(node.status).toBe("running");
    engine.cancelRoom("A"); await flush(); expect(aborted).toBe(true); expect(node.status).toBe("cancelled");
  }));
  it("stops a conversation without aborting the teammate already working, and drops only what had not started", () => fixture(async (engine, hooks) => {
    const source = { botId: "clive", threadId: "clive-chat" };
    const runs: Array<{ id: string; resumed: boolean }> = [];
    let finish!: (result: { ok: boolean; text: string }) => void;
    let aborted = false;
    // The second recipient is busy, so its assignment never leaves the queue.
    hooks.busy = node => node.botId === "reviewer";
    hooks.run = (node, resumed, signal) => {
      runs.push({ id: node.id, resumed });
      return new Promise(resolve => {
        signal.addEventListener("abort", () => { aborted = true; });
        finish = resolve;
      });
    };
    const running = engine.enqueue(source, "turn", undefined, { botId: "lead", threadId: "lead-task" }, "build", "Build the CSV export").node;
    const queued = engine.enqueue(source, "turn", undefined, { botId: "reviewer", threadId: "reviewer-task" }, "review", "Review the CSV export").node;
    engine.sourceSettled("turn", true);
    engine.tick(); await flush();
    expect(running.status).toBe("running");
    expect(queued.status).toBe("queued");
    expect(engine.outstandingDirect("clive-chat").map(node => node.botId)).toEqual(["lead", "reviewer"]);

    const left = engine.stopAwaitingDirect("clive-chat");
    expect(left.map(node => node.id)).toEqual([running.id]);
    // The teammate's own process is never reached into; only unstarted work goes.
    expect(aborted).toBe(false);
    expect(running.status).toBe("running");
    expect(queued.status).toBe("cancelled");
    // ...and this conversation stops being awaited.
    expect(engine.nodes.get("turn")?.status).toBe("cancelled");
    expect(engine.activeDirect("clive-chat")).toBe(false);
    expect(engine.outstandingDirect("clive-chat").map(node => node.botId)).toEqual(["lead"]);

    finish({ ok: true, text: "CSV export delivered" });
    await flush();
    for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
    // It finishes and its result is still recorded and reported to the
    // stopped conversation, which is never resumed.
    expect(running.status).toBe("completed");
    expect(running.result).toBe("CSV export delivered");
    expect((hooks.report as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].id)).toContain(running.id);
    expect(runs.map(run => run.id)).toEqual([running.id]);
  }));
  it("records interruption on restart without replaying side effects and fails closed on corrupt storage", () => fixture((engine, hooks, file) => {
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    const restarted = new RoomHandoffs(file, hooks); restarted.tick();
    expect(restarted.nodes.get(node.id)?.result).toContain("restart"); expect(hooks.run).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, "utf8")).every((n: { status: string }) => n.status === "failed")).toBe(true);
    writeFileSync(file, "{corrupt");
    expect(() => new RoomHandoffs(file, hooks).enqueue(addr("A"), "new", undefined, addr("B"), "work", "build")).toThrow("storage");
  }));
});
describe("room handoff lifetime budget", () => {
  it("parks queued work past the tree ceiling, then fails it at the queue window naming the wait", () => {
    let nowMs = 0;
    return fixture((engine, hooks) => {
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      hooks.busy = () => true;
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs + 1;
      engine.tick();
      expect(node.status).toBe("queued");
      expect(engine.nodes.get("turn")?.status).toBe("waiting");
      nowMs = ROOM_HANDOFF_LIMITS.queueMs + 1;
      engine.tick();
      expect(node.status).toBe("failed");
      expect(node.result).toContain("Room handoff queue budget exhausted");
      expect(node.result).toContain("never started while waiting for a busy teammate");
      expect(node.result).toContain("60m of the 60m queue window");
      expect(hooks.run).not.toHaveBeenCalled();
    }, () => nowMs);
  });
  it("runs parked work once the teammate frees up, then resumes the waiting source", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.busy = () => nowMs <= ROOM_HANDOFF_LIMITS.lifetimeMs + 60_000;
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs + 60_000;
      engine.tick(); await flush();
      expect(node.status).toBe("queued");
      expect(engine.nodes.get("turn")?.status).toBe("waiting");
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs + 61_000;
      engine.tick(); await flush();
      expect(node.startedAt).toBe(ROOM_HANDOFF_LIMITS.lifetimeMs + 61_000);
      for (let i = 0; i < 3; i++) { engine.tick(); await flush(); }
      expect(node.status).toBe("completed");
      expect(engine.nodes.get("turn")?.status).toBe("completed");
    }, () => nowMs);
  });
  it("pauses the lifetime clock while work executes, then fails it at the wall-clock hard cap", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      let aborted = false;
      hooks.run = (_node, _resumed, signal) => new Promise(resolve =>
        signal.addEventListener("abort", () => { aborted = true; resolve({ ok: false, text: "aborted" }); }));
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      nowMs = 24 * 60_000; engine.tick(); await flush();
      expect(node.status).toBe("running");
      // Past the tree ceiling and the node's own runway: the fixed clock
      // failed running work here, but the clock paused at 24m, so only 24m
      // of the 30m budget has aged and the node keeps executing.
      nowMs = 24 * 60_000 + ROOM_HANDOFF_LIMITS.minRunwayMs + 1_000;
      engine.tick(); await flush();
      expect(node.status).toBe("running");
      expect(aborted).toBe(false);
      // The wall-clock hard cap ignores pauses: a tree that never stops
      // executing still dies instead of extending its runway forever.
      nowMs = 45 * 60_000;
      engine.tick(); await flush();
      expect(node.status).toBe("failed");
      expect(aborted).toBe(true);
      expect(node.result).toContain("Room handoff hard cap exhausted");
      expect(node.result).toContain("node was running");
    }, () => nowMs, { hardCapMs: 45 * 60_000 });
  });
  it("refuses new work when only the hard-cap remainder is too short to honor the runway", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.run = () => new Promise(() => {});
      const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      expect(node.status).toBe("running");
      // 40m of wall clock with the tree paused leaves the full 30m lifetime
      // budget unspent, but only 5m before the 45m hard cap: less runway than
      // enqueue promises, so admission must refuse the follow-up.
      nowMs = 40 * 60_000;
      expect(() => engine.enqueue(node, "follow", node.id, addr("C"), "work", "more"))
        .toThrow("Room handoff budget exhausted");
    }, () => nowMs, { hardCapMs: 45 * 60_000 });
  });
  it("resumes a waiting parent past the ceiling and gives the follow-up its own runway", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const resumedAt: number[] = [];
      const finish: Record<string, (result: { ok: boolean; text: string }) => void> = {};
      hooks.run = (node, resumed, signal) => new Promise(resolve => {
        if (resumed) resumedAt.push(nowMs);
        finish[node.key] = resolve;
        signal.addEventListener("abort", () => resolve({ ok: false, text: "aborted" }));
      });
      engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build");
      engine.sourceSettled("turn", true);
      nowMs = 21 * 60_000; engine.tick(); await flush();
      expect(engine.children("turn")[0].status).toBe("running");
      // The child finishes inside its own runway but past the tree ceiling;
      // its execution paused the clock, so the parent still owes its resume.
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs + 60_000;
      finish.build({ ok: true, text: "done" }); await flush();
      engine.tick(); await flush();
      const parent = engine.nodes.get("turn")!;
      expect(parent.status).toBe("waiting");
      engine.tick(); await flush();
      expect(parent.status).toBe("running");
      expect(resumedAt).toEqual([ROOM_HANDOFF_LIMITS.lifetimeMs + 60_000]);
      expect(parent.startedAt).toBe(ROOM_HANDOFF_LIMITS.lifetimeMs + 60_000);
      // The fixed clock failed the resumed parent at its runway edge; the
      // paused clock keeps it alive until the wall-clock hard cap claims it.
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs + 60_000 + ROOM_HANDOFF_LIMITS.minRunwayMs;
      engine.tick(); await flush();
      expect(parent.status).toBe("running");
      nowMs = 45 * 60_000;
      engine.tick(); await flush();
      expect(parent.status).toBe("failed");
      expect(parent.result).toContain("Room handoff hard cap exhausted");
      expect(parent.result).toContain("node was running");
    }, () => nowMs, { hardCapMs: 45 * 60_000 });
  });
  it("pauses the lifetime clock while work executes and resumes it once execution stops", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      const finish: Record<string, (result: { ok: boolean; text: string }) => void> = {};
      hooks.run = node => new Promise(resolve => { finish[node.key] = resolve; });
      engine.enqueue(addr("A"), "turn", undefined, addr("B"), "build", "build");
      engine.sourceSettled("turn", true);
      nowMs = 10 * 60_000; engine.tick(); await flush();
      expect(engine.children("turn")[0].status).toBe("running");
      // 19m of wall clock has passed but the clock paused at 10m: the root
      // has aged 10m, so a follow-up still has a full runway. The fixed
      // clock refused here with only 1m of lifetime remaining.
      nowMs = 29 * 60_000;
      expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("C"), "followup", "more work")).not.toThrow();
      finish.build({ ok: true, text: "done" }); await flush();
      hooks.busy = () => true;
      engine.tick(); await flush();
      // Execution stopped and the clock resumed: by 46m the root has aged
      // 27m, and the 3m left cannot serve a minimum runway.
      nowMs = 46 * 60_000;
      expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("D"), "late", "more work"))
        .toThrow(/budget exhausted: only 3m of the 30m tree lifetime remains/);
    }, () => nowMs);
  });
  it("refuses follow-up work when the remaining lifetime cannot serve a minimum runway", () => {
    let nowMs = 0;
    return fixture(engine => {
      engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
      engine.sourceSettled("turn", true);
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs - ROOM_HANDOFF_LIMITS.minRunwayMs + 1;
      expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("C"), "followup", "more work"))
        .toThrow(/budget exhausted: only 9m of the 30m tree lifetime remains/);
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs + 1;
      expect(() => engine.enqueue(addr("A"), "turn", undefined, addr("D"), "late", "more work"))
        .toThrow(/budget exhausted: only 0s/);
    }, () => nowMs);
  });
  it("still serves a follow-up enqueued under an aged root with a full runway left", async () => {
    let nowMs = 0;
    await fixture(async (engine, hooks) => {
      hooks.run = node => node.key === "first"
        ? new Promise<{ ok: boolean; text: string }>(() => {})
        : Promise.resolve({ ok: true, text: "done" });
      engine.enqueue(addr("A"), "turn", undefined, addr("B"), "first", "build");
      engine.sourceSettled("turn", true);
      engine.tick(); await flush();
      nowMs = ROOM_HANDOFF_LIMITS.lifetimeMs - ROOM_HANDOFF_LIMITS.minRunwayMs;
      engine.enqueue(addr("A"), "turn", undefined, addr("C"), "followup", "more work");
      engine.tick(); await flush();
      const followup = engine.children("turn").find(n => n.key === "followup");
      expect(followup?.status).toBe("completed");
      expect(engine.nodes.get("turn")?.status).not.toBe("failed");
    }, () => nowMs);
  });
});
