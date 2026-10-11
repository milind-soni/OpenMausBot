import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomHandoffHooks } from "./room-handoffs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// Spied, not replaced: every call still reaches the real filesystem, and the
// test can count the fsyncs a handoff save costs. Load a fresh copy so
// room-handoffs and atomic see the spies.
vi.mock("node:fs", { spy: true });
vi.resetModules();
const spied = await import("node:fs");
const { RoomHandoffs, ROOM_HANDOFF_CUT_TWICE } = await import("./room-handoffs.ts");

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("room handoff saves", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir)));
  });

  function engine(run?: RoomHandoffHooks["run"]) {
    const dir = mkdtempSync(join(tmpdir(), "room-handoff-save-"));
    dirs.push(dir);
    const hooks: RoomHandoffHooks = {
      validate: () => undefined,
      busy: () => false,
      run: run ?? vi.fn(async () => ({ ok: true, text: "done" })),
      report: vi.fn(),
      changed: () => {},
    };
    return new RoomHandoffs(join(dir, "requests.json"), hooks);
  }

  it("fsyncs every acceptance before it returns", () => {
    const handoffs = engine();
    vi.mocked(spied.fsyncSync).mockClear();
    const source = { botId: "chief", threadId: "chief" };
    handoffs.enqueue(source, "turn", undefined, { botId: "a", threadId: "a" }, "a", "A");
    handoffs.enqueue(source, "turn", undefined, { botId: "b", threadId: "b" }, "b", "B");
    handoffs.enqueue(source, "turn", undefined, { botId: "c", threadId: "c" }, "c", "C");
    expect(spied.fsyncSync).toHaveBeenCalledTimes(3);
  });

  it("keeps a user stop on disk immediately", () => {
    const handoffs = engine();
    handoffs.enqueue({ groupId: "C", threadId: "C-thread", botId: "C-bot" }, "cancel", undefined, { groupId: "D", threadId: "D-thread", botId: "D-bot" }, "work", "cancel work");
    vi.mocked(spied.fsyncSync).mockClear();
    handoffs.cancelRoom("C");
    expect(spied.fsyncSync).toHaveBeenCalledTimes(2);
  });

  it("coalesces one tick and the settlements that resolve in that turn", async () => {
    const handoffs = engine();
    const source = { botId: "chief", threadId: "chief" };
    handoffs.enqueue(source, "turn", undefined, { botId: "a", threadId: "a" }, "a", "A");
    handoffs.enqueue(source, "turn", undefined, { botId: "b", threadId: "b" }, "b", "B");
    handoffs.enqueue(source, "turn", undefined, { botId: "c", threadId: "c" }, "c", "C");
    vi.mocked(spied.fsyncSync).mockClear();
    handoffs.sourceSettled("turn", true);
    handoffs.tick();
    // sourceSettled is its own accept-style write. Each start is written
    // before its child runs, and the tick's other changes ride along.
    expect(spied.fsyncSync).toHaveBeenCalledTimes(4);
    await flush();
    expect(spied.fsyncSync).toHaveBeenCalledTimes(5);
    expect([...handoffs.nodes.values()].filter(node => node.parentId).every(node => node.status === "completed")).toBe(true);
  });

  // The failure windows around the coalesced writes: what the file says when
  // a child starts, after a restart, and after a settlement write fails.
  function failing() {
    const dir = mkdtempSync(join(tmpdir(), "room-handoff-window-"));
    dirs.push(dir);
    const file = join(dir, "requests.json");
    const statusOnDisk = (id: string) => (JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; status: string; result: string }>).find(node => node.id === id);
    const seenAtStart: string[] = [];
    let settle: ((value: { ok: boolean; text: string }) => void) | undefined;
    const run = vi.fn((node: { id: string }) => {
      seenAtStart.push(statusOnDisk(node.id)!.status);
      return new Promise<{ ok: boolean; text: string }>(resolve => { settle = resolve; });
    });
    const changed = vi.fn();
    const validate = vi.fn<RoomHandoffHooks["validate"]>(() => undefined);
    const report = vi.fn();
    const hooks: RoomHandoffHooks = { validate, busy: () => false, run, report, changed };
    const handoffs = new RoomHandoffs(file, hooks);
    const source = { botId: "chief", threadId: "chief" };
    const { node } = handoffs.enqueue(source, "turn", undefined, { botId: "a", threadId: "a" }, "a", "A");
    handoffs.sourceSettled("turn", true);
    return { file, handoffs, node, run, changed, validate, report, seenAtStart, statusOnDisk, settle: (value: { ok: boolean; text: string }) => settle!(value) };
  }
  const failNextWrite = () => vi.mocked(spied.fsyncSync).mockImplementationOnce(() => { throw new Error("disk full"); });

  it("writes running before a child starts, and starts nothing when that write fails", () => {
    const { handoffs, node, run, seenAtStart, statusOnDisk } = failing();
    failNextWrite();
    expect(() => handoffs.tick()).toThrow("disk full");
    expect(run).not.toHaveBeenCalled();
    expect(handoffs.nodes.get(node.id)?.status).toBe("queued");
    expect(statusOnDisk(node.id)?.status).toBe("queued");

    handoffs.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(seenAtStart).toEqual(["running"]);
    expect(statusOnDisk(node.id)?.status).toBe("running");
  });

  it("saves a child a restart cut as owed once before it runs again, and as ended when a second restart cuts that run", async () => {
    const { file, handoffs, node, run, statusOnDisk } = failing();
    handoffs.tick();
    expect(run).toHaveBeenCalledTimes(1);

    const boot = () => {
      const hooks: RoomHandoffHooks = { validate: () => undefined, busy: () => false,
        run: vi.fn(() => new Promise<{ ok: boolean; text: string }>(() => {})), report: vi.fn(), changed: () => {} };
      return { hooks, engine: new RoomHandoffs(file, hooks) };
    };
    const second = boot();
    // On disk before anything runs: a crash now still runs it, once.
    expect(statusOnDisk(node.id)).toMatchObject({ status: "queued", restart: "rerun", restarts: 1 });
    second.engine.tick();
    expect(second.hooks.run).toHaveBeenCalledTimes(1);
    expect(statusOnDisk(node.id)).toMatchObject({ status: "running", restart: "rerun" });

    const third = boot();
    expect(statusOnDisk(node.id)).toMatchObject({ status: "failed", result: ROOM_HANDOFF_CUT_TWICE });
    third.engine.tick(); await flush(); third.engine.tick();
    expect(vi.mocked(third.hooks.run).mock.calls.map(([woken, resumed]) => [woken.id, resumed])).toEqual([["turn", true]]);
  });

  it("keeps a settlement whose write failed and saves it on the next tick", async () => {
    const { handoffs, node, settle, statusOnDisk, changed } = failing();
    handoffs.tick();
    changed.mockClear();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      failNextWrite();
      settle({ ok: true, text: "done" });
      await flush();
      expect(handoffs.nodes.get(node.id)?.status).toBe("completed");
      expect(statusOnDisk(node.id)?.status).toBe("running");
      expect(changed).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith("room handoffs:", expect.objectContaining({ message: "disk full" }));
    } finally {
      errors.mockRestore();
    }
    handoffs.tick();
    expect(statusOnDisk(node.id)?.status).toBe("completed");
    expect(changed).toHaveBeenCalledWith(new Set(), new Set(["a", "chief"]));
  });

  it("retains a failed tick's dirty state and notices even when the next tick changes nothing", () => {
    const { handoffs, node, validate, statusOnDisk, changed } = failing();
    // No report or runnable work on the retry: persistence must not depend on
    // some unrelated future mutation accidentally saving this cancellation.
    node.reported = true;
    validate.mockReturnValue("Access revoked");
    changed.mockClear();
    failNextWrite();
    expect(() => handoffs.tick()).toThrow("disk full");
    expect(statusOnDisk(node.id)?.status).toBe("queued");
    expect(changed).not.toHaveBeenCalled();
    handoffs.tick();
    expect(statusOnDisk(node.id)?.status).toBe("failed");
    expect(changed).toHaveBeenCalledWith(new Set(), new Set(["a", "chief"]));
  });

  it("does not report a cancellation until its terminal state reaches disk", () => {
    const { handoffs, node, validate, report, statusOnDisk } = failing();
    validate.mockReturnValue("Access revoked");
    report.mockImplementation(() => expect(statusOnDisk(node.id)?.status).toBe("failed"));
    failNextWrite();
    expect(() => handoffs.tick()).toThrow("disk full");
    expect(report).not.toHaveBeenCalled();
    handoffs.tick();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
