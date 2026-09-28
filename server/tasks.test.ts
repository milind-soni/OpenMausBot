// Tasks: a bot's separate contexts.
//
// The load-bearing property is isolation — each task keeps its own
// transcript AND its own provider session. If resume cursors leaked
// between tasks, a "fresh" task would silently resume the previous
// conversation, which is the exact thing tasks exist to prevent.
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
  // freshStore resets the module graph, so this closes the same SQLite
  // module instance that the freshly imported Store used.
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
    // a brand new context: nothing carried over from the greeting thread
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
    // the new task must NOT inherit the old session
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

    // only the first message names it
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
    // nothing more to name once the row carries a title
    expect(store.titleTaskFromFirstMessage(bot.id, "a second message", task.threadId)).toBeNull();
  });

  it("cannot be re-armed by restoring the sentinel title after the first attempt", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    store.titleTaskFromFirstMessage(bot.id, "Audit the payroll", task.threadId);
    // a person renames the row back to a sentinel: the first message
    // already had its naming attempt, so a later message cannot retitle it
    store.renameTask(bot.id, task.threadId, "New thread");
    expect(store.titleTaskFromFirstMessage(bot.id, "a follow-up message", task.threadId)).toBeNull();
    expect(store.activeTask(bot.id)!.title).toBe("New thread");
  });

  it("swaps a machine-made title for a generated one, exactly once", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    const snippet = store.titleTaskFromFirstMessage(bot.id, "Audit the payroll", task.threadId)!.title;
    // a person's rename wins over anything generated later
    store.renameTask(bot.id, task.threadId, "Payroll audit");
    expect(store.retitleTask(bot.id, task.threadId, snippet, "Payroll checks")).toBeNull();
    expect(store.activeTask(bot.id)!.title).toBe("Payroll audit");
    // and where nothing intervened, the generated title lands once — a
    // second answer aimed at the same snippet finds nothing to replace
    const other = store.createTask(bot.id)!;
    const otherSnippet = store.titleTaskFromFirstMessage(bot.id, "Draft the announcement", other.threadId)!.title;
    expect(store.retitleTask(bot.id, other.threadId, otherSnippet, "Draft announcement")).toMatchObject({ threadId: other.threadId });
    expect(store.retitleTask(bot.id, other.threadId, otherSnippet, "A second opinion")).toBeNull();
    expect(store.taskByThread(bot.id, other.threadId)!.title).toBe("Draft announcement");
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
    // deleting the ACTIVE task falls back to one that still exists
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
      title: UNTITLED_THREAD, resumeCursors: {}, modelSelection: bot.modelSelection,
      busy: false, unread: false, activity: "idle",
    });
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
      // the surviving task keeps its logs
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
    // and it is named from the conversation rather than left blank
    expect(migrated[0]!.title).not.toBe(UNTITLED_TASK);
  });
});
