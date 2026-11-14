// Whole-file saves of bots.json and routines.json: fewer writes, and at every point the server yields to the event loop
// (where a crash or an exit can land) the files hold what one write per change would have left.
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

  it("write a manual run four times, and a restart after any step reads what that step saved", async () => {
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

    const run = manager.runNow(routine.id)!;
    expect(restart()).toMatchObject({ id: run.id, status: "queued" });
    await manager.tick();
    expect(JSON.parse(readFileSync(file, "utf8")).runs[0]).toMatchObject({ status: "running", threadId: "thread-1" });

    const deliver = (rest: Record<string, unknown>) => batchSaves(() => manager.handleRuntimeEvent(event("thread-1", rest)));
    deliver({ type: "turn.started" });
    deliver({ type: "item.completed", itemType: "assistant_text", text: "Calendar clear." });
    expect(JSON.parse(readFileSync(file, "utf8")).runs[0]).toMatchObject({ status: "running", output: "Calendar clear." });
    batchSaves(() => {
      manager.handleRuntimeEvent(event("thread-1", { type: "turn.completed", ok: true }));
      manager.noteReport(run.id, { state: "pending" });
      manager.noteReport(run.id, { state: "quiet" });
    });
    expect(JSON.parse(readFileSync(file, "utf8")).runs[0]).toMatchObject({ status: "completed", output: "Calendar clear.", report: { state: "quiet" } });
    expect(writesOf("routines.json")).toBe(4);
    expect(readFileSync(file, "utf8")).not.toContain("\n");
  });
});
