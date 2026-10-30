import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-tasks-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, UNTITLED_TASK, UNTITLED_THREAD, titleFromMessage } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), UNTITLED_TASK, UNTITLED_THREAD, titleFromMessage };
}

afterEach(async () => {
  // freshStore resets the module graph, so this closes the same SQLite module instance the fresh Store used.
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("tasks", () => {
  it("gives every new bot one task pointing at its thread", async () => {
    const { store, UNTITLED_THREAD } = await freshStore();
    const bot = store.createBot();
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(store.activeTask(bot.id)).toMatchObject({ threadId: bot.threadId, title: UNTITLED_THREAD });
  });

  it("starts a new task on a fresh thread and makes it active", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const firstThread = bot.threadId;
    const task = store.createTask(bot.id)!;

    expect(task.threadId).not.toBe(firstThread);
    expect(store.bot(bot.id)!.threadId).toBe(task.threadId);
    expect(store.tasks(bot.id).map((t) => t.threadId)).toEqual([task.threadId, firstThread]);
    expect(store.messagesFor(task.threadId)).toHaveLength(0);
    expect(store.messagesFor(firstThread).length).toBeGreaterThan(0);
  });

  it("can create a detached routine task without changing the visible conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const visibleThread = bot.threadId;
    const routineTask = store.createTask(bot.id, "Morning brief", false)!;

    expect(routineTask.threadId).not.toBe(visibleThread);
    expect(store.bot(bot.id)!.threadId).toBe(visibleThread);
    expect(store.botByThread(routineTask.threadId)?.id).toBe(bot.id);

    store.setResumeCursor(bot.id, "claude", "routine-session", routineTask.threadId);
    expect(store.taskByThread(bot.id, routineTask.threadId)?.resumeCursors.claude).toBe("routine-session");
    expect(store.activeTask(bot.id)?.resumeCursors.claude).toBeUndefined();
  });

  it("keeps provider sessions apart — the whole point of a task", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    store.setResumeCursor(bot.id, "claude", "session-one");

    const second = store.createTask(bot.id)!;
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBeUndefined();
    store.setResumeCursor(bot.id, "claude", "session-two");

    store.switchTask(bot.id, first);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-one");
    store.switchTask(bot.id, second.threadId);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-two");
  });

  it("names a task after the first thing you asked it", async () => {
    const { store, UNTITLED_THREAD, titleFromMessage } = await freshStore();
    const bot = store.createBot();
    store.createTask(bot.id);
    expect(store.activeTask(bot.id)!.title).toBe(UNTITLED_THREAD);

    store.titleTaskFromFirstMessage(bot.id, "Audit the payroll spreadsheet\nand flag anything odd");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");

    store.titleTaskFromFirstMessage(bot.id, "something else entirely");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");
    expect(titleFromMessage("x".repeat(80))).toHaveLength(48);
  });

  it("returns the task it named, so a caller knows which title it may replace", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    const titled = store.titleTaskFromFirstMessage(bot.id, "Audit the payroll", task.threadId);
    expect(titled?.threadId).toBe(task.threadId);
    expect(titled?.title).toBe("Audit the payroll");
    expect(store.titleTaskFromFirstMessage(bot.id, "a second message", task.threadId)).toBeNull();
  });

  it("names a task from the first line as typed; nothing in the words is stripped", async () => {
    const { store, titleFromMessage } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    expect(store.titleTaskFromFirstMessage(bot.id, "Compare monthly sales\nKeep the chart", task.threadId)?.title).toBe("Compare monthly sales");
    const typed = "<data-context>{bad}</data-context>";
    expect(titleFromMessage(`${typed}\nKeep this visible`)).toBe(typed);
  });

  it("cannot be re-armed by restoring the sentinel title after the first attempt", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    store.titleTaskFromFirstMessage(bot.id, "Audit the payroll", task.threadId);
    store.renameTask(bot.id, task.threadId, "New thread");
    expect(store.titleTaskFromFirstMessage(bot.id, "a follow-up message", task.threadId)).toBeNull();
    expect(store.activeTask(bot.id)!.title).toBe("New thread");
  });

  it("swaps a machine-made title for a generated one, exactly once", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    const snippet = store.titleTaskFromFirstMessage(bot.id, "Audit the payroll", task.threadId)!.title;
    store.renameTask(bot.id, task.threadId, "Payroll audit");
    expect(store.retitleTask(bot.id, task.threadId, snippet, "Payroll checks")).toBeNull();
    expect(store.activeTask(bot.id)!.title).toBe("Payroll audit");
    const other = store.createTask(bot.id)!;
    const otherSnippet = store.titleTaskFromFirstMessage(bot.id, "Draft the announcement", other.threadId)!.title;
    expect(store.retitleTask(bot.id, other.threadId, otherSnippet, "Draft announcement")).toMatchObject({ threadId: other.threadId });
    expect(store.retitleTask(bot.id, other.threadId, otherSnippet, "A second opinion")).toBeNull();
    expect(store.taskByThread(bot.id, other.threadId)!.title).toBe("Draft announcement");
  });

  it("lets Regenerate title replace a chosen name, unless it was renamed while the title was generating", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    store.renameTask(bot.id, task.threadId, "Payroll audit");
    expect(store.retitleTask(bot.id, task.threadId, "Payroll audit", "Quarterly payroll export")).toMatchObject({ title: "Quarterly payroll export" });
    store.renameTask(bot.id, task.threadId, "Export checks");
    expect(store.retitleTask(bot.id, task.threadId, "Quarterly payroll export", "Payroll export review")).toBeNull();
    expect(store.taskByThread(bot.id, task.threadId)!.title).toBe("Export checks");
  });

  it("reads a usable title out of a model reply", async () => {
    const { titleFromLlm } = await import("./store.ts");
    expect(titleFromLlm('"Fix login timeout."\n')).toBe("Fix login timeout");
    expect(titleFromLlm("Fix the login\nthat is the whole answer")).toBe("Fix the login");
    expect(titleFromLlm("Fix   the\tlogin")).toBe("Fix the login");
    expect(titleFromLlm("\u201CFix login timeout\u201D")).toBe("Fix login timeout");
    expect(titleFromLlm("## Fix login")).toBe("Fix login");
    expect(titleFromLlm('"## Deploy app"')).toBe("Deploy app");
    expect(titleFromLlm("# Room deploy plan")).toBe("Room deploy plan");
    expect(titleFromLlm("- Fix the login flow")).toBe("Fix the login flow");
    expect(titleFromLlm("**Deploy the app**")).toBe("Deploy the app");
    expect(titleFromLlm("")).toBeNull();
    expect(titleFromLlm("   \n  ")).toBeNull();
    expect(titleFromLlm(`${"word".repeat(13)}`)).toBeNull();
  });

  it("deletes a task with its transcript and replaces the last one with fresh context", async () => {
    const { store, UNTITLED_THREAD } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "secret" });

    expect(store.deleteTask(bot.id, second.threadId)).toBeTruthy();
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(store.bot(bot.id)!.threadId).toBe(first);
    expect(store.messagesFor(second.threadId)).toHaveLength(0);

    store.appendMessage(first, { role: "user", kind: "text", text: "Finished work" });
    store.setResumeCursor(bot.id, "claude", "old-session");
    store.patchTask(bot.id, first, {
      title: "Finished work", rewound: true, pinnedMessageId: "old-pin", unread: true,
      modelSelection: { instanceId: "codex", model: "thread-only-override" },
    });
    expect(store.deleteTask(bot.id, first)).toBeTruthy();
    expect(store.tasks(bot.id)).toHaveLength(1);
    const replacement = store.activeTask(bot.id)!;
    expect(replacement.threadId).not.toBe(first);
    expect(replacement).toMatchObject({
      title: UNTITLED_THREAD, resumeCursors: {},
      busy: false, unread: false, activity: "idle",
    });
    expect(replacement.modelSelection).toBeUndefined();
    expect(store.projectBotForTask(bot.id, replacement.threadId)?.modelSelection).toEqual(bot.modelSelection);
    expect(replacement.pinnedMessageId).toBeUndefined();
    expect(replacement.rewound).toBeUndefined();
    expect(bot.resumeCursors).toEqual({});
    expect(bot.pinnedMessageId).toBeUndefined();
    expect(bot.unread).toBe(false);
    expect(store.messagesFor(first)).toHaveLength(0);
    expect(store.messagesFor(replacement.threadId)).toHaveLength(0);
    expect(store.deleteTask(bot.id, first)).toBeNull();
    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.bot(bot.id)?.threadId).toBe(replacement.threadId);
    expect(reloaded.tasks(bot.id)).toHaveLength(1);
    expect(reloaded.messagesFor(replacement.threadId)).toHaveLength(0);
  });

  it("deletes a task's event logs along with its transcript", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id)!;
    const { EVENTS_DIR, NATIVE_DIR } = await import("./config.ts");
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${first}.ndjson`), "{}\n");
      writeFileSync(join(dir, `${second.threadId}.ndjson`), "{}\n");
    }

    expect(store.deleteTask(bot.id, second.threadId)).toBeTruthy();

    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      expect(existsSync(join(dir, `${second.threadId}.ndjson`))).toBe(false);
      expect(existsSync(join(dir, `${first}.ndjson`))).toBe(true);
    }
  });

  it("deleting a bot removes every member thread's event logs", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const original = bot.threadId;
    const extra = store.createTask(bot.id)!;
    const { EVENTS_DIR, NATIVE_DIR } = await import("./config.ts");
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${original}.ndjson`), "{}\n");
      writeFileSync(join(dir, `${extra.threadId}.ndjson`), "{}\n");
    }

    expect(store.deleteBot(bot.id)).toBe(true);

    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      for (const threadId of [original, extra.threadId]) {
        expect(existsSync(join(dir, `${threadId}.ndjson`))).toBe(false);
      }
    }
  });

  it("adopts a pre-tasks bot's endless thread as its first task", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Plan the offsite" });
    // simulate a record saved before tasks existed
    const legacy = store.bot(bot.id)!;
    delete (legacy as { tasks?: unknown }).tasks;
    // patchBot persists, so what lands on disk is the pre-tasks shape
    store.patchBot(bot.id, { resumeCursors: { claude: "old-session" } });

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    const migrated = reloaded.tasks(bot.id);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ threadId: bot.threadId, resumeCursors: { claude: "old-session" } });
    expect(migrated[0]!.title).not.toBe(UNTITLED_TASK);
  });

  it("deleteTasks removes several tasks in one pass with one bot event and per-thread deleted events", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const b = store.createTask(bot.id)!;
    const c = store.createTask(bot.id)!;
    const d = store.createTask(bot.id)!;
    for (const t of [b, c, d]) store.appendMessage(t.threadId, { role: "user", kind: "text", text: `msg ${t.threadId}` });
    const { EVENTS_DIR } = await import("./config.ts");
    mkdirSync(EVENTS_DIR, { recursive: true });
    for (const id of [first, b.threadId, c.threadId]) writeFileSync(join(EVENTS_DIR, `${id}.ndjson`), "{}\n");
    const events: Array<{ type: string; threadId?: string }> = [];
    store.onChange((change) => events.push(change as { type: string; threadId?: string }));

    const result = store.deleteTasks(bot.id, [b.threadId, c.threadId, c.threadId, "no-such-thread"])!;

    expect(result.deleted).toEqual([b.threadId, c.threadId]);
    expect(result.missing).toEqual(["no-such-thread"]);
    expect(store.tasks(bot.id).map((t) => t.threadId)).toEqual([d.threadId, first]);
    expect(store.messagesFor(b.threadId)).toHaveLength(0);
    expect(store.messagesFor(c.threadId)).toHaveLength(0);
    expect(store.messagesFor(d.threadId)).toHaveLength(1);
    expect(existsSync(join(EVENTS_DIR, `${b.threadId}.ndjson`))).toBe(false);
    expect(existsSync(join(EVENTS_DIR, `${first}.ndjson`))).toBe(true);
    expect(events.filter((e) => e.type === "bot")).toHaveLength(1);
    expect(events.filter((e) => e.type === "thread.deleted").map((e) => e.threadId)).toEqual([b.threadId, c.threadId]);
    expect(store.bot(bot.id)!.threadId).toBe(d.threadId);

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.tasks(bot.id).map((t) => t.threadId)).toEqual([d.threadId, first]);
  });

  it("deleteTasks of every task leaves exactly one fresh active conversation and one bot event", async () => {
    const { store, UNTITLED_THREAD } = await freshStore();
    const bot = store.createBot();
    const all = [bot.threadId, store.createTask(bot.id)!.threadId, store.createTask(bot.id)!.threadId];
    const events: Array<{ type: string }> = [];
    store.onChange((change) => events.push(change as { type: string }));

    const result = store.deleteTasks(bot.id, all)!;

    expect(result.deleted.sort()).toEqual([...all].sort());
    expect(store.tasks(bot.id)).toHaveLength(1);
    const fresh = store.activeTask(bot.id)!;
    expect(all).not.toContain(fresh.threadId);
    expect(fresh).toMatchObject({ title: UNTITLED_THREAD, resumeCursors: {}, busy: false, unread: false, activity: "idle" });
    expect(store.bot(bot.id)!.threadId).toBe(fresh.threadId);
    expect(events.filter((e) => e.type === "bot")).toHaveLength(1);
    expect(store.deleteTasks(bot.id, all)!.deleted).toEqual([]);
  });

  it("deleteTasks moves the active pointer to a surviving visible task and skips routine-run tasks", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const routine = store.createTask(bot.id, "Morning brief", false)!;
    store.patchTask(bot.id, routine.threadId, { routineRunId: "run-1" } as never);
    const active = store.createTask(bot.id)!;
    expect(store.bot(bot.id)!.threadId).toBe(active.threadId);

    store.deleteTasks(bot.id, [active.threadId]);

    expect(store.bot(bot.id)!.threadId).toBe(first);
    expect(store.tasks(bot.id).map((t) => t.threadId).sort()).toEqual([first, routine.threadId].sort());
  });

  it("deleteTasks of the open thread opens the newest-active thread, not the newest-created one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { store } = await freshStore();
      vi.setSystemTime(1_000);
      const bot = store.createBot();
      const first = bot.threadId;
      vi.setSystemTime(2_000);
      const second = store.createTask(bot.id)!.threadId;
      vi.setSystemTime(3_000);
      const newestCreated = store.createTask(bot.id)!.threadId;
      vi.setSystemTime(4_000);
      store.appendMessage(first, { role: "user", kind: "text", text: "back to the first one" });
      vi.setSystemTime(5_000);
      store.appendMessage(second, { role: "user", kind: "text", text: "and the second" });
      store.switchTask(bot.id, second);

      store.deleteTasks(bot.id, [second]);

      expect(store.bot(bot.id)!.threadId).toBe(first);
      expect(store.tasks(bot.id).map((t) => t.threadId)).toEqual([newestCreated, first]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deleteTasks of the open thread prefers a pinned thread and passes over archived, closed, snoozed and bot-opened ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { store } = await freshStore();
      vi.setSystemTime(1_000);
      const bot = store.createBot();
      const pinned = bot.threadId;
      store.patchTask(bot.id, pinned, { pinned: true });
      vi.setSystemTime(2_000);
      const plain = store.createTask(bot.id, "Plain")!.threadId;
      vi.setSystemTime(3_000);
      store.patchTask(bot.id, store.createTask(bot.id, "Archived")!.threadId, { archivedAt: 3_000 });
      vi.setSystemTime(4_000);
      store.setTaskClosedBy(bot.id, store.createTask(bot.id, "Closed")!.threadId, { botId: bot.id, name: bot.name, at: 4_000 });
      vi.setSystemTime(5_000);
      store.createTask(bot.id, "Opened by a bot", true, undefined, { botId: "other", name: "Other", at: 5_000 });
      vi.setSystemTime(5_500);
      store.patchTask(bot.id, store.createTask(bot.id, "Snoozed")!.threadId, { snoozedUntil: 0 });
      vi.setSystemTime(6_000);
      const open = store.createTask(bot.id, "Open")!.threadId;

      store.deleteTasks(bot.id, [open]);
      expect(store.bot(bot.id)!.threadId).toBe(pinned);

      store.patchTask(bot.id, pinned, { pinned: undefined });
      store.switchTask(bot.id, pinned);
      store.deleteTasks(bot.id, [pinned]);
      expect(store.bot(bot.id)!.threadId).toBe(plain);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deleteTasks returns null for an unknown bot and changes nothing", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    expect(store.deleteTasks("no-such-bot", [bot.threadId])).toBeNull();
    expect(store.tasks(bot.id)).toHaveLength(1);
  });

  it("deleteTasks leaves tasks and files untouched when the database delete fails", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const b = store.createTask(bot.id)!;
    const c = store.createTask(bot.id)!;
    for (const t of [b, c]) store.appendMessage(t.threadId, { role: "user", kind: "text", text: "keep me" });
    const { EVENTS_DIR, DATA_DIR } = await import("./config.ts");
    mkdirSync(EVENTS_DIR, { recursive: true });
    writeFileSync(join(EVENTS_DIR, `${b.threadId}.ndjson`), "{}\n");
    const { DatabaseSync } = await import("node:sqlite");
    const breaker = new DatabaseSync(join(DATA_DIR, "messages.db"));
    breaker.exec(`CREATE TRIGGER boom BEFORE DELETE ON messages WHEN old.thread_id = '${c.threadId}'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    breaker.close();
    const events: Array<{ type: string }> = [];
    store.onChange((change) => events.push(change as { type: string }));

    expect(() => store.deleteTasks(bot.id, [b.threadId, c.threadId])).toThrow("boom");

    expect(store.tasks(bot.id).map((t) => t.threadId)).toContain(b.threadId);
    expect(store.tasks(bot.id).map((t) => t.threadId)).toContain(c.threadId);
    expect(store.messagesFor(b.threadId)).toHaveLength(1);
    expect(existsSync(join(EVENTS_DIR, `${b.threadId}.ndjson`))).toBe(true);
    expect(events.filter((e) => e.type === "thread.deleted" || e.type === "bot")).toEqual([]);
  });
});
