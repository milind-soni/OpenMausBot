import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { approvalModeFor } from "../shared/approval-mode.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { isProjectEmoji, Store, type BotRecord, type TaskPatch } from "./store.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "default" });
const savedBots = (): BotRecord[] => JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));

describe("independent bot task state", () => {
  // The shared Vitest setup gives this file its own disposable home.
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("persists routine execution identity without sharing context or approval settings", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const first = store.createTask(bot.id, "First run", false)!;
    const second = store.createTask(bot.id, "Second run", false)!;
    store.patchTask(bot.id, first.threadId, { routineRunId: "run-1" });
    store.patchTask(bot.id, second.threadId, { routineRunId: "run-2" });
    store.setResumeCursor(bot.id, "claude", "first-session", first.threadId);
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, first.threadId)).toMatchObject({ routineRunId: "run-1", resumeCursors: { claude: "first-session" } });
    expect(reloaded.taskByThread(bot.id, second.threadId)).toMatchObject({ routineRunId: "run-2", resumeCursors: {}, approvalMode: "ask", autoApprove: false });
    reloaded.patchTask(bot.id, first.threadId, { routineRunId: undefined });
    expect(new Store(selection).taskByThread(bot.id, first.threadId)?.routineRunId).toBeUndefined();
  });

  it("never silently switches into an internal run when deleting a visible task", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const original = bot.threadId;
    const results = store.createTask(bot.id, "Results")!;
    const execution = store.createTask(bot.id, "Execution", false)!;
    store.patchTask(bot.id, execution.threadId, { routineRunId: "run-1" });
    expect(store.deleteTask(bot.id, results.threadId)?.threadId).toBe(original);
    expect(store.deleteTask(bot.id, original)).not.toBeNull();
    expect(bot.threadId).not.toBe(execution.threadId);
    expect(store.activeTask(bot.id)?.routineRunId).toBeUndefined();
    expect(store.tasks(bot.id).filter((task) => !task.routineRunId)).toHaveLength(1);
    expect(new Store(selection).bot(bot.id)?.threadId).toBe(bot.threadId);
  });

  it("leaves an opened internal run when a different visible task is deleted", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const original = bot.threadId;
    const results = store.createTask(bot.id, "Results", false)!;
    const execution = store.createTask(bot.id, "Execution", false)!;
    store.patchTask(bot.id, execution.threadId, { routineRunId: "run-1" });
    store.switchTask(bot.id, execution.threadId);

    expect(store.deleteTask(bot.id, results.threadId)?.threadId).toBe(original);
    expect(store.activeTask(bot.id)?.routineRunId).toBeUndefined();
    expect(store.taskByThread(bot.id, execution.threadId)?.routineRunId).toBe("run-1");
    expect(new Store(selection).bot(bot.id)?.threadId).toBe(original);
  });

  it("caps new task titles before persistence and preserves the blank-title fallback", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, `  ${"t".repeat(120)}  `)!;
    expect(task.title).toBe("t".repeat(80));
    expect(new Store(selection).taskByThread(bot.id, task.threadId)?.title).toBe(task.title);
    expect(store.createTask(bot.id, "  ")?.title).toBe("New thread");
  });

  it("retains generated and user-selected project files when conversations are deleted", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const first = ensureTaskWorkspace(bot.id, bot.threadId);
    const secondTask = store.createTask(bot.id)!;
    const second = ensureTaskWorkspace(bot.id, secondTask.threadId);
    const chosen = join(DATA_DIR, "user-selected-project");
    mkdirSync(chosen);
    for (const folder of [first, second, chosen]) writeFileSync(join(folder, "result.txt"), "Keep my project");
    store.patchBot(bot.id, { cwd: chosen });
    expect(store.deleteTask(bot.id, secondTask.threadId)).not.toBeNull();
    expect(existsSync(join(second, "result.txt"))).toBe(true);
    expect(store.deleteBot(bot.id)).toBe(true);
    for (const folder of [first, second, chosen]) expect(readFileSync(join(folder, "result.txt"), "utf8")).toBe("Keep my project");
  });

  it("keeps model, approvals, cursor, rewind and pin snapshots across navigation, deletion and reload", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const first = bot.threadId;
    store.patchTask(bot.id, first, {
      modelSelection: { instanceId: "codex", model: "first", effort: "high" },
      approvalMode: "auto",
      autoApprove: true,
      alwaysAllow: ["Bash:git"],
      rewound: true,
      pinnedMessageId: "first-pin",
    });
    store.setResumeCursor(bot.id, "codex", { session: "first-session" }, first);
    store.appendMessage(first, { role: "user", kind: "text", text: "First conversation" });
    store.patchBot(bot.id, {
      modelSelection: { instanceId: "claude", model: "second-default" },
      approvalMode: "ask",
      alwaysAllow: ["Read"],
    });
    const second = store.createTask(bot.id)!;
    expect(second).toMatchObject({
      modelSelection: { instanceId: "claude", model: "second-default" },
      approvalMode: "ask",
      alwaysAllow: ["Read"],
      resumeCursors: {},
    });
    expect(bot.rewound).toBeUndefined();
    expect(bot.pinnedMessageId).toBeUndefined();
    store.setResumeCursor(bot.id, "claude", "second-session");
    store.patchTask(bot.id, second.threadId, { pinnedMessageId: "second-pin" });
    store.patchBot(bot.id, { modelSelection: selection(), alwaysAllow: ["Other"] });
    const detached = store.createTask(bot.id, "Background", false)!;
    expect(bot.threadId).toBe(second.threadId);

    store.switchTask(bot.id, first);
    expect(bot).toMatchObject({
      modelSelection: selection(),
      resumeCursors: { codex: { session: "first-session" } },
      rewound: true,
      pinnedMessageId: "first-pin",
    });
    expect(store.projectBotForTask(bot.id, first)).toMatchObject({
      modelSelection: { instanceId: "codex", model: "first", effort: "high" },
      approvalMode: "auto",
      alwaysAllow: ["Bash:git"],
    });
    expect(store.projectBotForTask(bot.id, second.threadId)).toMatchObject({
      modelSelection: { instanceId: "claude", model: "second-default" },
      alwaysAllow: ["Read"],
    });
    store.deleteTask(bot.id, detached.threadId);
    store.deleteTask(bot.id, first);
    expect(bot).toMatchObject({ threadId: second.threadId, pinnedMessageId: "second-pin", resumeCursors: { claude: "second-session" } });
    expect(bot.rewound).toBeUndefined();
    const reloaded = new Store(selection);
    expect(reloaded.projectBotForTask(bot.id, second.threadId)).toMatchObject({
      modelSelection: { instanceId: "claude", model: "second-default" },
      approvalMode: "ask",
      alwaysAllow: ["Read"],
      resumeCursors: { claude: "second-session" },
      pinnedMessageId: "second-pin",
    });
    expect(reloaded.bot(bot.id)?.modelSelection).toEqual(selection());
  });

  it("projects cloned dispatch settings and permits only constrained task fields", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.activeTask(bot.id)!;
    const modelSelection: ModelSelection = { instanceId: "codex", model: "task" };
    const alwaysAllow = ["Read"];
    store.patchTask(bot.id, task.threadId, {
      modelSelection, alwaysAllow, resumeCursors: { codex: { session: "original" } },
      threadId: "replacement", activity: "working", busy: true,
    } as TaskPatch);
    modelSelection.model = "caller-mutated";
    alwaysAllow.push("Bash");
    expect(task.modelSelection?.model).toBe("task");
    expect(task.alwaysAllow).toEqual(["Read"]);
    expect(task.threadId).toBe(bot.threadId);
    expect(task.busy).toBe(false);
    const projected = store.projectBotForTask(bot.id, task.threadId)!;
    projected.modelSelection.model = "snapshot-mutated";
    projected.alwaysAllow!.push("Write");
    (projected.resumeCursors.codex as { session: string }).session = "snapshot-mutated";
    expect(task.modelSelection?.model).toBe("task");
    expect(task.alwaysAllow).toEqual(["Read"]);
    expect(task.resumeCursors).toEqual({ codex: { session: "original" } });
    expect(store.projectBotForTask(bot.id, "missing")).toBeNull();
    expect(store.patchTask(bot.id, "missing", { unread: true })).toBeNull();
  });

  it("aggregates independent task activity without persisting it or clearing another task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id, undefined, false)!;
    const seen: string[] = [];
    store.onChange((change) => seen.push(change.type));
    store.setTaskActivity(bot.id, first, "working");
    store.setTaskActivity(bot.id, second.threadId, "waiting-on-you");
    store.setTaskActivity(bot.id, second.threadId, "waiting-on-you");
    expect(seen).toEqual(["bot", "bot"]);
    expect(bot).toMatchObject({ activity: "waiting-on-you", busy: true });
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "idle");
    expect(bot).toMatchObject({ activity: "waiting-on-you", busy: true });
    store.setTaskActivity(bot.id, first, "idle");
    expect(bot.busy).toBe(true);
    expect(store.projectBotForTask(bot.id, first)).toMatchObject({ activity: "idle", busy: false });
    store.switchTask(bot.id, second.threadId);
    store.patchBot(bot.id, { name: "Saved while working" });
    expect(savedBots()[0]).not.toHaveProperty("busy");
    expect(savedBots()[0]).not.toHaveProperty("activity");
    for (const task of savedBots()[0]!.tasks!) {
      expect(task).not.toHaveProperty("busy");
      expect(task).not.toHaveProperty("activity");
    }
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toMatchObject({ activity: "idle", busy: false });
    expect(reloaded.tasks(bot.id).every((task) => task.activity === "idle" && !task.busy)).toBe(true);
    store.deleteTask(bot.id, second.threadId);
    expect(bot).toMatchObject({ activity: "idle", busy: false });
  });

  it("keeps background unread after reading the selected task, including across restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id, undefined, false)!;
    store.patchTask(bot.id, first, { unread: true });
    store.patchTask(bot.id, second.threadId, { unread: true });
    store.patchBot(bot.id, { unread: false });
    expect(store.taskByThread(bot.id, first)?.unread).toBe(false);
    expect(second.unread).toBe(true);
    expect(bot.unread).toBe(true);
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.unread).toBe(true);
    reloaded.switchTask(bot.id, second.threadId);
    reloaded.patchBot(bot.id, { unread: false });
    expect(reloaded.bot(bot.id)?.unread).toBe(false);
  });

  it("migrates legacy model, cursor, pin and unread without losing transcripts or stale active pointers", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = bot.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "Original conversation" });
    const second = store.createTask(bot.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Second conversation" });
    const legacy = savedBots();
    const raw = legacy[0]!;
    raw.threadId = first;
    raw.tasks = raw.tasks!.filter((task) => task.threadId !== first);
    delete raw.tasks[0]!.modelSelection;
    raw.tasks[0]!.activity = "working";
    raw.tasks[0]!.busy = true;
    raw.modelSelection = { instanceId: "legacy-engine", model: "legacy-model" };
    raw.resumeCursors = { "legacy-engine": "old-session" };
    raw.rewound = true;
    raw.pinnedMessageId = "legacy-pin";
    raw.unread = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(legacy));
    const migrated = new Store(selection);
    expect(migrated.tasks(bot.id)).toHaveLength(2);
    expect(migrated.projectBotForTask(bot.id, first)).toMatchObject({
      modelSelection: raw.modelSelection,
      resumeCursors: { "legacy-engine": "old-session" },
      rewound: true,
      pinnedMessageId: "legacy-pin",
      unread: true,
    });
    expect(migrated.taskByThread(bot.id, second.threadId)).toMatchObject({ modelSelection: raw.modelSelection, activity: "idle", busy: false });
    expect(migrated.messagesFor(first).at(-1)?.text).toBe("Original conversation");
    expect(migrated.messagesFor(second.threadId).at(-1)?.text).toBe("Second conversation");
    expect(savedBots()[0]!.tasks).toHaveLength(2);
    expect(savedBots()[0]!.tasks!.every((task) => task.modelSelection?.model === "legacy-model")).toBe(true);
  });

  it("revokes elevated task snapshots along with a stale bot elevation grant", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "full", autoApprove: true });
    const task = store.createTask(bot.id)!;
    expect(approvalModeFor(store.projectBotForTask(bot.id, task.threadId)!)).toBe("full");
    store.patchBot(bot.id, {
      approvalGrant: { requestId: "uncommitted", mode: "full", phase: "prepared" },
    });
    expect(approvalModeFor(store.projectBotForTask(bot.id, task.threadId)!)).toBe("ask");
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, task.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false });
    expect(approvalModeFor(reloaded.projectBotForTask(bot.id, task.threadId)!)).toBe("ask");
  });

  it("groups threads in folders without changing model snapshots or running state", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const legacyThread = bot.threadId;
    expect(bot.projects ?? []).toEqual([]);
    const project = store.createProject(bot.id, "  Website  ")!;
    const other = store.createProject(bot.id, "Research")!;
    const task = store.createTask(bot.id, "Landing page", true, project.id)!;
    expect(task).toMatchObject({ projectId: project.id, modelSelection: selection() });
    store.patchTask(bot.id, task.threadId, { modelSelection: { instanceId: "codex", model: "thread-specific" } });
    store.setResumeCursor(bot.id, "codex", "project-session", task.threadId);
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: "Keep this conversation" });
    store.pinTaskCwd(bot.id, task.threadId, "/task-specific-folder");
    store.setTaskActivity(bot.id, task.threadId, "working");
    const running = store.projectBotForTask(bot.id, task.threadId)!;
    store.patchProject(bot.id, project.id, { name: "Site" });
    store.patchTask(bot.id, task.threadId, { projectId: other.id });
    expect(task).toMatchObject({ projectId: other.id, modelSelection: running.modelSelection, busy: true, resumeCursors: { codex: "project-session" }, cwd: null });
    const next = store.createTask(bot.id, "Next project thread", false, project.id)!;
    expect(next.modelSelection).toEqual(selection());
    expect(store.activeTask(bot.id)?.threadId).toBe(task.threadId);
    store.deleteProject(bot.id, other.id);
    expect(task.projectId).toBeUndefined();
    expect(task.busy).toBe(true);
    expect(store.messagesFor(task.threadId).at(-1)?.text).toBe("Keep this conversation");
    expect(store.taskByThread(bot.id, legacyThread)).toBeTruthy();
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.projects).toEqual([{ id: project.id, name: "Site" }]);
    expect(reloaded.taskByThread(bot.id, next.threadId)?.projectId).toBe(project.id);
    expect(reloaded.taskByThread(bot.id, task.threadId)?.projectId).toBeUndefined();
    expect(reloaded.projectBotForTask(bot.id, task.threadId)?.modelSelection).toEqual(running.modelSelection);
  });

  it("persists folder order and emoji without creating threads or changing their settings", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const originalThread = bot.threadId;
    const originalTasks = structuredClone(store.tasks(bot.id));
    const first = store.createProject(bot.id, "Website", "👩🏽‍💻")!;
    const second = store.createProject(bot.id, "Research", "🇮🇳")!;
    const legacy = store.createProject(bot.id, "No emoji")!;
    expect(bot.threadId).toBe(originalThread);
    expect(store.tasks(bot.id)).toEqual(originalTasks);
    expect(legacy).toEqual({ id: legacy.id, name: "No emoji" });
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));
    expect(store.reorderProjects(bot.id, [legacy.id, second.id, first.id])).toEqual([legacy, second, first]);
    expect(changes).toEqual([{ type: "bot", botId: bot.id }]);
    let reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.projects).toEqual([legacy, second, first]);
    expect(reloaded.tasks(bot.id)).toEqual(originalTasks);
    expect(reloaded.patchProject(bot.id, first.id, { name: "Site", emoji: "❤️" })).toMatchObject({ name: "Site", emoji: "❤️" });
    reloaded = new Store(selection);
    expect(reloaded.project(bot.id, first.id)?.emoji).toBe("❤️");
    expect(reloaded.patchProject(bot.id, first.id, { emoji: null })).not.toHaveProperty("emoji");
    reloaded = new Store(selection);
    expect(reloaded.project(bot.id, first.id)).toEqual({ id: first.id, name: "Site" });
    expect(reloaded.bot(bot.id)?.projects?.map((project) => project.id)).toEqual([legacy.id, second.id, first.id]);
    expect(reloaded.project(bot.id, second.id)?.emoji).toBe("🇮🇳");
    expect(reloaded.tasks(bot.id)).toEqual(originalTasks);
  });

  it("rejects invalid folder order and emoji without partially changing saved state", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const sibling = store.createBot();
    const first = store.createProject(bot.id, "One", "📁")!;
    const second = store.createProject(bot.id, "Two", "🔬")!;
    const foreign = store.createProject(sibling.id, "Sibling")!;
    for (const ids of [[], [first.id], [first.id, first.id], [first.id, "missing"], [first.id, foreign.id], [first.id, second.id, foreign.id]]) {
      expect(store.reorderProjects(bot.id, ids)).toBeNull();
    }
    expect(store.reorderProjects("missing-bot", [])).toBeNull();
    expect(store.createProject(bot.id, "Invalid", "two words")).toBeNull();
    expect(store.patchProject(bot.id, first.id, { name: "Should not change", emoji: "📁📁" })).toBeNull();
    expect(store.patchProject(sibling.id, first.id, { emoji: "⭐" })).toBeNull();
    expect(new Store(selection).bot(bot.id)?.projects).toEqual([first, second]);
    const task = store.createTask(bot.id, "Keep thread", true, first.id)!;
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: "Keep history" });
    store.deleteProject(bot.id, first.id);
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.projects).toEqual([second]);
    expect(reloaded.taskByThread(bot.id, task.threadId)?.projectId).toBeUndefined();
    expect(reloaded.messagesFor(task.threadId).at(-1)?.text).toBe("Keep history");
  });

  it("accepts one Unicode emoji, including composed forms, but not text or incomplete components", () => {
    for (const emoji of ["📁", "🗂️", "👩🏽‍💻", "👩‍👩‍👦", "🇮🇳", "👍🏽", "❤️", "♥", "1️⃣"]) {
      expect(isProjectEmoji(emoji), emoji).toBe(true);
    }
    for (const emoji of ["", "folder", "📁📁", "📁x", "📁\n", " 📁", "1", "🇮", "🏽", "📁\u200d", "☕🏽", "a".repeat(65), null, 1, {}]) {
      expect(isProjectEmoji(emoji), JSON.stringify(emoji)).toBe(false);
    }
  });

  it("discards unshipped folder model defaults without changing saved thread models", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const sibling = store.createBot();
    const project = store.createProject(bot.id, "General", "⭐")!;
    store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "codex", model: "existing-thread" } });
    expect(store.createTask(bot.id, undefined, false, project.id)?.modelSelection).toEqual(selection());
    expect(store.createTask(sibling.id, undefined, false, project.id)).toBeNull();
    expect(store.patchTask(sibling.id, sibling.threadId, { projectId: project.id })).toBeNull();
    expect(store.deleteProject(sibling.id, project.id)).toBeNull();
    expect(store.patchProject(sibling.id, project.id, { name: "Wrong owner" })).toBeNull();
    const saved = savedBots();
    Object.assign(saved.find((entry) => entry.id === bot.id)!.projects![0], { modelSelection: { instanceId: "codex", model: "removed-folder-default" } });
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(saved));
    const reloaded = new Store(selection);
    expect(reloaded.project(bot.id, project.id)).toEqual({ id: project.id, name: "General", emoji: "⭐" });
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.modelSelection).toEqual({ instanceId: "codex", model: "existing-thread" });
    expect(reloaded.createTask(bot.id, undefined, false, project.id)?.modelSelection).toEqual(selection());
  });
});
