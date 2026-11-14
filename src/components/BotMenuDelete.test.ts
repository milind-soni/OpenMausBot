import { describe, expect, it, vi } from "vitest";
import { api, type Bot } from "@/state/store";
import { allThreadRows, deleteAllThreads, deleteAllThreadsCopy } from "./BotMenuDelete";

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
