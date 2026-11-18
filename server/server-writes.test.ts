// Whole-file saves of bots.json and routines.json: fewer writes, and at every point the server yields to the event loop
// (where a crash or an exit can land) the files hold what one write per change would have left, except a routine run's
// progress, which may lag by one window (server/routine-progress-save.ts).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spied, not replaced: every call reaches the real filesystem, and a test counts the renames a save costs.
vi.mock("node:fs", { spy: true });
vi.resetModules();
const fs = await import("node:fs");
const { DATA_DIR } = await import("./config.ts");
const { batchSaves } = await import("./save-batch.ts");
const { Store } = await import("./store.ts");
const { RoutineManager } = await import("./routines.ts");
const { RUN_PROGRESS_WINDOW_MS } = await import("./routine-progress-save.ts");
type RuntimeEvent = import("./contracts.ts").RuntimeEvent;

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
// By file name, so a Windows path (backslashes) counts the same as any other.
const writesOf = (name: string) => vi.mocked(fs.renameSync).mock.calls.filter(([, to]) => basename(String(to)) === name).length;
const reads = (name: string) => vi.mocked(fs.readFileSync).mock.calls.filter(([path]) => basename(String(path)) === name).length;
const bots = () => readFileSync(join(DATA_DIR, "bots.json"), "utf8");

describe("bots.json saves", () => {
  beforeEach(() => {
    // Not the whole folder: on Windows the open messages database holds it.
    rmSync(join(DATA_DIR, "bots.json"), { force: true });
    vi.mocked(fs.renameSync).mockClear();
  });

  it("are compact, and skip an unchanged save without reading the file back", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Pepper" });
    expect(bots()).not.toContain("\n");
    store.patchTask(bot.id, bot.threadId, { lastContextModel: "claude:claude-sonnet-5" });
    const writes = writesOf("bots.json");
    const before = reads("bots.json");
    store.patchTask(bot.id, bot.threadId, { lastContextModel: "claude:claude-sonnet-5" });
    store.setResumeCursor(bot.id, "claude", "session-1", bot.threadId);
    store.setResumeCursor(bot.id, "claude", "session-1", bot.threadId);
    expect(writesOf("bots.json")).toBe(writes + 1);
    expect(reads("bots.json")).toBe(before);
  });

  it("land once per batch, and the file holds every change when the batch returns", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Pepper" });
    const writes = writesOf("bots.json");
    batchSaves(() => {
      store.titleTaskFromFirstMessage(bot.id, "Plan the offsite", bot.threadId);
      store.setTaskAskedAt(bot.id, bot.threadId, 1_000);
      store.patchTask(bot.id, bot.threadId, { unread: false });
      store.setResumeCursor(bot.id, "claude", "session-1", bot.threadId);
      store.markTaskDispatched(bot.id, bot.threadId, "claude");
      store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 5, costUsd: 0.01 });
      store.patchTask(bot.id, bot.threadId, { unread: true });
      expect(writesOf("bots.json")).toBe(writes);
    });
    expect(writesOf("bots.json")).toBe(writes + 1);
    // A crash here, with no exit handler run, starts from exactly this.
    const task = new Store(selection).taskByThread(bot.id, bot.threadId)!;
    expect(task).toMatchObject({ title: "Plan the offsite", askedAt: 1_000, unread: true, lastInstanceId: "claude", resumeCursors: { claude: "session-1" } });
    expect(task.usage).toMatchObject({ input: 10, output: 5, turns: 1 });
  });

  it("write a permission change at once, even inside a batch", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Pepper" });
    batchSaves(() => {
      store.patchTask(bot.id, bot.threadId, { approvalMode: "ask" });
      expect(new Store(selection).taskByThread(bot.id, bot.threadId)?.approvalMode).toBe("ask");
    });
  });

  it("keep a change whose batched save failed, and the next save writes it", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Pepper" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    batchSaves(() => store.setTaskAskedAt(bot.id, bot.threadId, 2_000));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    expect(new Store(selection).taskByThread(bot.id, bot.threadId)?.askedAt).toBeUndefined();
    store.setTaskAskedAt(bot.id, bot.threadId, 3_000);
    expect(new Store(selection).taskByThread(bot.id, bot.threadId)?.askedAt).toBe(3_000);
  });
});

describe("routines.json saves", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-routine-writes-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const event = (threadId: string, rest: Record<string, unknown>) =>
    ({ eventId: `e-${Math.random()}`, provider: "claudeAgent", threadId, turnId: "turn-1", createdAt: new Date().toISOString(), ...rest }) as unknown as RuntimeEvent;

  const setup = () => {
    const file = join(dir, "routines.json");
    const options = {
      file,
      botState: () => "ready" as const,
      createTask: () => ({ threadId: "thread-1" }),
      startTurn: async () => {},
    };
    const manager = new RoutineManager(options);
    const routine = manager.create({ name: "Morning", prompt: "Summarise.", botId: "bot-1", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    vi.mocked(fs.renameSync).mockClear();
    const restart = () => new RoutineManager({ ...options, startTurn: async () => {} }).listRuns()[0];
    const onDisk = () => JSON.parse(readFileSync(file, "utf8")).runs[0];
    const deliver = (rest: Record<string, unknown>) => batchSaves(() => manager.handleRuntimeEvent(event("thread-1", rest)));
    return { file, manager, routine, restart, onDisk, deliver };
  };

  afterEach(() => vi.useRealTimers());

  it("write a manual run three times, and a restart after any step reads the status that step left", async () => {
    const { file, manager, routine, restart, onDisk, deliver } = setup();

    const run = manager.runNow(routine.id)!;
    expect(restart()).toMatchObject({ id: run.id, status: "queued" });
    await manager.tick();
    expect(onDisk()).toMatchObject({ status: "running", threadId: "thread-1" });

    deliver({ type: "turn.started" });
    deliver({ type: "item.completed", itemType: "assistant_text", text: "Calendar clear." });
    // Progress waits for its window; the status a restart acts on is already there.
    expect(onDisk()).toMatchObject({ status: "running" });
    expect(onDisk().output).toBeUndefined();
    batchSaves(() => {
      manager.handleRuntimeEvent(event("thread-1", { type: "turn.completed", ok: true }));
      manager.noteReport(run.id, { state: "pending" });
      manager.noteReport(run.id, { state: "quiet" });
    });
    expect(onDisk()).toMatchObject({ status: "completed", output: "Calendar clear.", report: { state: "quiet" } });
    expect(writesOf("routines.json")).toBe(3);
    expect(readFileSync(file, "utf8")).not.toContain("\n");
    manager.close();
  });

  it("save a long run's progress once per window, so a crash loses at most that window", async () => {
    const { manager, routine, restart, onDisk, deliver } = setup();
    manager.runNow(routine.id);
    await manager.tick();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = writesOf("routines.json");

    // Ten replies a second apart, with a question asked and answered between them.
    for (let step = 1; step <= 10; step++) {
      deliver({ type: "item.completed", itemType: "assistant_text", text: `Step ${step} done.` });
      if (step === 4) deliver({ type: "request.opened", requestId: "r1", requestType: "permission", tool: "shell", summary: "ls" });
      if (step === 4) deliver({ type: "request.resolved", requestId: "r1", behavior: "allow", source: "user" });
      vi.advanceTimersByTime(1_000);
    }
    expect(writesOf("routines.json") - started).toBe(10_000 / RUN_PROGRESS_WINDOW_MS);
    expect(onDisk()).toMatchObject({ status: "running", output: "Step 10 done." });

    // A crash inside the next window: the newest reply is lost, the run restarts as a running one always has.
    deliver({ type: "item.completed", itemType: "assistant_text", text: "Step 11 done." });
    expect(onDisk().output).toBe("Step 10 done.");
    const restarted = restart();
    expect(restarted).toMatchObject({ status: "queued", retried: "restarted", output: "Step 10 done." });

    const before = writesOf("routines.json");
    deliver({ type: "turn.completed", ok: true });
    expect(onDisk()).toMatchObject({ status: "completed", output: "Step 11 done." });
    // The end took the waiting progress with it and cancelled the window: nothing writes again.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RUN_PROGRESS_WINDOW_MS);
    expect(writesOf("routines.json")).toBe(before + 1);
    manager.close();
  });

  it("write waiting progress when the scheduler stops for a backup or a move, and at once from shutdown on", async () => {
    const { manager, routine, onDisk, deliver } = setup();
    manager.runNow(routine.id);
    await manager.tick();
    deliver({ type: "item.completed", itemType: "assistant_text", text: "Half way." });
    expect(onDisk().output).toBeUndefined();
    manager.stop();
    expect(onDisk().output).toBe("Half way.");

    manager.start();
    manager.close();
    deliver({ type: "item.completed", itemType: "assistant_text", text: "Nearly there." });
    expect(onDisk().output).toBe("Nearly there.");
  });

  it("retry failed progress writes before stopping for a backup or shutdown", async () => {
    const { manager, routine, onDisk, deliver } = setup();
    manager.runNow(routine.id);
    await manager.tick();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver({ type: "item.completed", itemType: "assistant_text", text: "Keep this completed step." });
      vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
      vi.advanceTimersByTime(RUN_PROGRESS_WINDOW_MS);
      expect(error).toHaveBeenCalled();
      expect(onDisk().output).toBeUndefined();
      manager.stop();
      expect(onDisk().output).toBe("Keep this completed step.");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      error.mockRestore();
      manager.close();
    }
  });
});
