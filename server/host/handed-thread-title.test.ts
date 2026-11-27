import { describe, expect, it, vi } from "vitest";
import type { BotRecord, TaskRecord } from "../store.ts";
import { standingWorkTitle, createHandedThreadTitle } from "./handed-thread-title.ts";

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
    p.title("dana", "work-1", "Implement the CSV export", "Clive");
    await p.generate.mock.results[0]?.value;
    expect(p.titleOf()).toBe("@Clive · CSV export build");
    expect(p.generate).toHaveBeenCalledWith({}, "Implement the CSV export");
  });

  it("keeps a rename made while the name was being thought of", async () => {
    const p = place({ renamedTo: "Mine" });
    p.title("dana", "work-1", "Implement the CSV export", "Clive");
    await p.generate.mock.results[0]?.value;
    expect(p.generate).toHaveBeenCalled();
    expect(p.titleOf()).toBe("Mine");
  });

  it("keeps two jobs distinguishable for the same long sender", () => {
    const sender = "x".repeat(78);
    expect(standingWorkTitle(sender, "Audit returns")).toMatch(/ · Audit returns$/);
    expect(standingWorkTitle(sender, "Count orders")).toMatch(/ · Count orders$/);
  });

  it("keeps distinct explicit labels when they fit after a short sender", () => {
    const first = `${"x".repeat(58)}a`, second = `${"x".repeat(58)}b`;
    expect(standingWorkTitle("A", "brief", first)).toBe(`@A · ${first}`);
    expect(standingWorkTitle("A", "brief", second)).toBe(`@A · ${second}`);
    expect(standingWorkTitle("A", "brief", "x".repeat(100)).length).toBeLessThanOrEqual(80);
  });

  it("scrubs recognized credentials from explicit titles, model input and generated titles", async () => {
    const credential = `sk-test-${"a".repeat(24)}`;
    expect(standingWorkTitle("Dana", "Export audit", `Check ${credential}`)).toMatch(/^@Dana · Check «redacted/);
    const p = place({ answer: `Audit ${credential}` });
    p.title("dana", "work-1", `Export ${credential}`, "Clive");
    await p.generate.mock.results[0]?.value;
    expect(p.generate).toHaveBeenCalledWith({}, expect.stringMatching(/^Export «redacted/));
    expect(p.titleOf()).toMatch(/^@Clive · Audit «redacted/);
  });

  it("keeps its first title when the model can't name it, gives no name, or there is nothing to name it from", async () => {
    for (const [p, brief, botId] of [[place({ gate: false }), "Implement it", "dana"], [place({ answer: null }), "Implement it", "dana"],
      [place(), "   ", "dana"], [place(), "Implement it", "gone"]] as const) {
      p.title(botId, "work-1", brief, "Clive");
      await p.generate.mock.results[0]?.value;
      expect(p.titleOf()).toBe("@Clive · work");
    }
  });
});
