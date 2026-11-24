import { describe, expect, it, vi } from "vitest";
import type { BotRecord, TaskRecord } from "../store.ts";
import { createHandedThreadTitle } from "./handed-thread-title.ts";

function place(options: { gate?: boolean; answer?: string | null; renamedTo?: string } = {}) {
  const tasks = new Map<string, { title: string }>([["work-1", { title: "@Clive · work" }]]);
  const generate = vi.fn(async () => {
    if (options.renamedTo) tasks.get("work-1")!.title = options.renamedTo;
    return options.answer === undefined ? "CSV export build" : options.answer;
  });
  const title = createHandedThreadTitle({
    store: {
      bot: (id) => (id === "dana" ? ({ id } as BotRecord) : null),
      taskByThread: (_botId, threadId) => tasks.get(threadId) as TaskRecord | undefined,
      retitleTask: (_botId, threadId, machineTitle, next) => {
        const task = tasks.get(threadId);
        if (!task || task.title !== machineTitle) return null;
        task.title = next;
        return task as TaskRecord;
      },
    },
    gate: () => (options.gate === false ? { ok: false } : { ok: true, instance: {} }),
    generate,
  });
  return { title, generate, titleOf: () => tasks.get("work-1")!.title };
}

describe("a thread a teammate opened", () => {
  it("is named from the job it was handed, behind who handed it", async () => {
    const p = place();
    p.title("dana", "work-1", "Implement the CSV export", "@Clive · ");
    await vi.waitFor(() => expect(p.titleOf()).toBe("@Clive · CSV export build"));
    expect(p.generate).toHaveBeenCalledWith({}, "Implement the CSV export");
  });

  it("keeps a rename made while the name was being thought of", async () => {
    const p = place({ renamedTo: "Mine" });
    p.title("dana", "work-1", "Implement the CSV export", "@Clive · ");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.generate).toHaveBeenCalled();
    expect(p.titleOf()).toBe("Mine");
  });

  it("keeps its first title when the model can't name it, gives no name, or there is nothing to name it from", async () => {
    for (const [p, brief, botId] of [[place({ gate: false }), "Implement it", "dana"], [place({ answer: null }), "Implement it", "dana"],
      [place(), "   ", "dana"], [place(), "Implement it", "gone"]] as const) {
      p.title(botId, "work-1", brief, "@Clive · ");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(p.titleOf()).toBe("@Clive · work");
    }
  });
});
