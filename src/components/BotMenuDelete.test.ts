import { describe, expect, it, vi } from "vitest";
import { api, type Bot } from "@/state/store";
import { allThreadRows, closedThreadRows, deleteAllThreads, deleteAllThreadsCopy } from "./BotMenuDelete";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: vi.fn() }));

const bot: Bot = {
  id: "maus", threadId: "open", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "open", title: "Open chat", createdAt: 3 },
    { threadId: "pinned", title: "Pinned chat", createdAt: 2, pinned: true },
    { threadId: "run", title: "Morning brief run", createdAt: 1, routineRunId: "run-1" },
  ],
};

describe("delete all threads", () => {
  it("covers every thread except routine runs, with the open thread's running state", () => {
    const rows = allThreadRows({ ...bot, busy: true, activity: "working" });
    expect(rows.map((row) => row.threadId)).toEqual(["open", "pinned"]);
    expect(rows.find((row) => row.threadId === "open")).toMatchObject({ busy: true, activity: "working" });
  });

  it("says a new empty conversation starts only when nothing is running, and counts pinned threads", () => {
    const idle = deleteAllThreadsCopy(allThreadRows(bot));
    expect(idle.title).toBe("Delete all threads (2)?");
    expect(idle.confirmLabel).toBe("Delete 2");
    expect(idle.body).toContain("Pinned threads included: 1.");
    expect(idle.body).toContain("a new empty conversation will be started");
    const running = deleteAllThreadsCopy(allThreadRows({ ...bot, busy: true, activity: "working" }));
    expect(running.body).not.toContain("a new empty conversation will be started");
  });

  it("sends every thread, running ones too, and says plainly which were kept", async () => {
    const post = vi.mocked(api);
    post.mockResolvedValueOnce({ deleted: ["pinned"], refused: [{ threadId: "open", reason: "busy" }], bot: { id: "maus" } });
    const dispatch = vi.fn();

    await deleteAllThreads({ ...bot, busy: true, activity: "working" }, dispatch);

    expect(post).toHaveBeenCalledWith("/api/bots/maus/tasks/delete", { method: "POST", body: JSON.stringify({ threadIds: ["open", "pinned"] }) });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "notice", notice: { kind: "note", botName: null, text: "Deleted: 1. Kept because they are running: 1." } });
  });
});

describe("delete closed threads", () => {
  const closer = { botId: "helper", name: "Helper", at: 5 };
  const closedBot: Bot = {
    ...bot,
    tasks: [
      { threadId: "open", title: "Open chat", createdAt: 5 },
      { threadId: "done", title: "Finished job", createdAt: 4, closedBy: closer },
      { threadId: "done-pinned", title: "Pinned finished job", createdAt: 3, pinned: true, closedBy: closer },
      { threadId: "done-run", title: "Closed routine run", createdAt: 2, routineRunId: "run-2", closedBy: closer },
      { threadId: "old", title: "Older finished job", createdAt: 1, archivedAt: 9, closedBy: closer },
    ],
  };

  it("takes only closed threads, never pinned ones or routine runs", () => {
    expect(closedThreadRows(allThreadRows(closedBot)).map((row) => row.threadId)).toEqual(["done", "old"]);
  });

  it("names the closed threads in the confirm and keeps the other threads", () => {
    const copy = deleteAllThreadsCopy(allThreadRows(closedBot), false, "closed");
    expect(copy.title).toBe("Delete closed threads (2)?");
    expect(copy.confirmLabel).toBe("Delete 2");
    expect(copy.body).not.toContain("Pinned threads included");
    expect(copy.body).not.toContain("a new empty conversation will be started");
    expect(deleteAllThreadsCopy(allThreadRows(closedBot), true, "closed").title).toBe("Delete closed conversations (2)?");
  });

  it("sends only the closed threads", async () => {
    const post = vi.mocked(api);
    post.mockResolvedValueOnce({ deleted: ["done", "old"], refused: [], bot: { id: "maus" } });
    const dispatch = vi.fn();

    await deleteAllThreads(closedBot, dispatch, "closed");

    expect(post).toHaveBeenLastCalledWith("/api/bots/maus/tasks/delete", { method: "POST", body: JSON.stringify({ threadIds: ["done", "old"], scope: "closed" }) });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "notice", notice: { kind: "note", botName: null, text: "Deleted: 2." } });
  });

  it("keeps an idle closed thread selectable while the bot works in another thread", () => {
    const working = { ...closedBot, busy: true, activity: "working" as const };
    expect(closedThreadRows(allThreadRows(working)).map((row) => row.threadId)).toEqual(["done", "old"]);
  });

  it("still leaves out a closed thread that is itself running", () => {
    const tasks = closedBot.tasks!.map((task) => (task.threadId === "done" ? { ...task, activity: "working" as const } : task));
    expect(closedThreadRows(allThreadRows({ ...closedBot, tasks })).map((row) => row.threadId)).toEqual(["old"]);
  });

  it("says how many were kept because they were reopened or pinned meanwhile", async () => {
    const post = vi.mocked(api);
    post.mockResolvedValueOnce({ deleted: ["old"], refused: [{ threadId: "done", reason: "not-closed" }], bot: { id: "maus" } });
    const dispatch = vi.fn();

    await deleteAllThreads(closedBot, dispatch, "closed");

    expect(dispatch).toHaveBeenLastCalledWith({ type: "notice", notice: { kind: "note", botName: null, text: "Deleted: 1. Kept because they were reopened or pinned: 1." } });
  });
});
