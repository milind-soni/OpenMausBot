import { describe, expect, it, vi } from "vitest";
import type { BotRecord, TaskRecord } from "../store.ts";
import { createHandedThreadTitle } from "./handed-thread-title.ts";
import { createAutomaticThreadTitles, TITLE_REPLY_WAIT_MS } from "./thread-titles.ts";

function place() {
  const task = { title: "@Clive · work" } as TaskRecord;
  const generate = vi.fn<typeof import("../thread-title-generate.ts").generateThreadTitle>().mockResolvedValue("CSV export build");
  const titles = createAutomaticThreadTitles(generate);
  const title = createHandedThreadTitle({
    store: {
      projectBotForTask: (id) => id === "dana" ? { id } as BotRecord : null,
      taskByThread: (id) => id === "dana" ? task : undefined,
      retitleTask: (_botId, _threadId, machineTitle, next) => {
        if (task.title !== machineTitle) return null;
        task.title = next;
        return task;
      },
    },
    gate: () => ({ ok: true, instance: {} }),
    start: titles.start,
  });
  return { title, titles, generate, task };
}

describe("a thread a teammate opened", () => {
  it("waits for the right reply and keeps the prefix on its generated title", async () => {
    const p = place();
    p.title("dana", "work-1", "Implement the CSV export", "@Clive · ");
    p.titles.turnStarted("work-1", "current");
    p.titles.turnEnded("work-1", "previous", "An earlier reply");
    expect(p.generate).not.toHaveBeenCalled();
    p.titles.turnEnded("work-1", "current", "Added accounting CSV support.");
    await vi.waitFor(() => expect(p.task.title).toBe("@Clive · CSV export build"));
    expect(p.generate).toHaveBeenCalledExactlyOnceWith({}, "User: Implement the CSV export\nBot: Added accounting CSV support.", "first-reply");
  });

  it("accepts a room summary reply from the next speaker after an empty turn", async () => {
    const p = place();
    p.title("dana", "work-1", "Implement it", "@Clive · ");
    p.titles.turnStarted("work-1", "first", true);
    p.titles.turnStarted("work-1", "reask", true);
    p.titles.turnEnded("work-1", "first", "Old progress message");
    expect(p.generate).not.toHaveBeenCalled();
    p.titles.turnEnded("work-1", "reask", "Implemented.");
    await vi.waitFor(() => expect(p.task.title).toBe("@Clive · CSV export build"));
    expect(p.generate).toHaveBeenCalledExactlyOnceWith({}, "User: Implement it\nBot: Implemented.", "first-reply");
  });

  it("keeps a manual rename even if the text matches the opening title", async () => {
    const p = place();
    p.generate.mockImplementationOnce(async () => {
      p.task.titleMode = "manual";
      return "New name";
    });
    p.title("dana", "work-1", "Implement it", "@Clive · ");
    p.titles.turnEnded("work-1", "current", "Implemented.");
    await Promise.resolve();
    expect(p.generate).toHaveBeenCalledOnce();
    expect(p.task.title).toBe("@Clive · work");
  });

  it("uses the first visible follow-up reply even after the initial-title wait", async () => {
    vi.useFakeTimers();
    try {
      const p = place();
      p.titles.start("thread", { request: "Export", currentTitle: "Reports", model: () => ({ ok: true, instance: {} }), stillCurrent: () => true, apply: vi.fn() });
      p.titles.turnStarted("thread", "turn");
      await vi.advanceTimersByTimeAsync(TITLE_REPLY_WAIT_MS);
      expect(p.generate).not.toHaveBeenCalled();
      p.titles.replyReceived("thread", "turn", "First reply");
      p.titles.turnEnded("thread", "turn", "Last reply");
      expect(p.generate).toHaveBeenCalledExactlyOnceWith({}, expect.stringContaining("First reply"), "follow-up");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the sanitised brief once after the wait runs out and ignores a late reply", async () => {
    vi.useFakeTimers();
    try {
      const p = place();
      p.title("dana", "work-1", 'Implement it <attached-image path="/private/image" />', "@Clive · ");
      await vi.advanceTimersByTimeAsync(TITLE_REPLY_WAIT_MS - 1);
      expect(p.generate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(p.generate).toHaveBeenCalledExactlyOnceWith({}, "User: Implement it", "first-message");
      p.titles.turnEnded("work-1", "current", "Implemented.");
      expect(p.generate).toHaveBeenCalledOnce();
      expect(p.task.title).toBe("@Clive · CSV export build");
    } finally {
      vi.useRealTimers();
    }
  });
});
