import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomHandoffs, ROOM_HANDOFF_LIMITS, type RoomHandoffHooks } from "./room-handoffs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const addr = (id: string) => ({ groupId: id, threadId: `${id}-thread`, botId: `${id}-bot` });
async function fixture(test: (engine: RoomHandoffs, hooks: RoomHandoffHooks, file: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "room-handoff-unit-"));
  const hooks: RoomHandoffHooks = { validate: () => undefined, busy: () => false,
    run: vi.fn(async () => ({ ok: true, text: "done" })), report: vi.fn(), changed: () => {} };
  try { const file = join(dir, "requests.json"); await test(new RoomHandoffs(file, hooks), hooks, file); }
  finally { await removeTempDir(dir); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("addressed room request tree", () => {
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
    hooks.report = child => { delivered.push(child.groupId); };
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
  it("records interruption on restart without replaying side effects and fails closed on corrupt storage", () => fixture((engine, hooks, file) => {
    const { node } = engine.enqueue(addr("A"), "turn", undefined, addr("B"), "work", "build");
    const restarted = new RoomHandoffs(file, hooks); restarted.tick();
    expect(restarted.nodes.get(node.id)?.result).toContain("restart"); expect(hooks.run).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, "utf8")).every((n: { status: string }) => n.status === "failed")).toBe(true);
    writeFileSync(file, "{corrupt");
    expect(() => new RoomHandoffs(file, hooks).enqueue(addr("A"), "new", undefined, addr("B"), "work", "build")).toThrow("storage");
  }));
});
