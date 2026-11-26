import { describe, expect, it } from "vitest";

import { replayToolCalls } from "../context-rebuild.ts";
import { isContextMessage } from "../delta-context.ts";
import { reviewTranscript } from "../skill-review.ts";
import type { Message } from "../store.ts";
import { handedLine, handedMainThread, handedSummary, postHandedLine, writeHandedLine, type HandedLineDeps } from "./handed-line.ts";

const MOCHI = { botId: "mochi", name: "Mochi" };
const KAI = { botId: "kai", name: "Kai" };

function fakeStore(threads: Record<string, { title: string; archivedAt?: number }>, path: Message[] = []) {
  const main = [...path];
  const calls: string[] = [];
  const store = {
    taskByThread: (_botId: string, threadId: string) => threads[threadId] ? { threadId, ...threads[threadId] } : undefined,
    activePath: () => main,
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      calls.push(`append ${threadId}`);
      const full = { ...message, id: `m${main.length + 1}`, at: main.length + 1 } as Message;
      main.push(full);
      return full;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
      calls.push(`patch ${threadId} ${id}`);
      const index = main.findIndex((message) => message.id === id);
      main[index] = { ...main[index]!, ...patch };
      return main[index]!;
    },
    patchTask: () => { calls.push("patchTask"); return null; },
  } as unknown as HandedLineDeps["store"];
  return { store, main, calls, deps: { store, mainThread: () => "main" } as HandedLineDeps };
}

const person = (id: string): Message => ({ id, at: 0, role: "user", kind: "text", text: "hello" });

describe("the hand-off line in a helper's main chat", () => {
  it("records who asked and for what, opens the hand-off thread, and marks nothing unread", () => {
    const { main, calls, deps } = fakeStore({ main: { title: "Garden" }, work: { title: "Octopus facts" } });
    expect(postHandedLine(deps, { botId: "sage", threadId: "work", from: MOCHI, text: "Find three octopus facts", title: "Octopus facts" })).toBe("m1");
    expect(main).toEqual([expect.objectContaining({
      role: "bot", kind: "activity",
      tool: { name: "Mochi asked me: Octopus facts", ok: true, nameCode: "chat.notice.askedMe", nameParams: { bot: "Mochi", title: "Octopus facts" } },
      threadRef: { botId: "sage", threadId: "work", title: "Octopus facts" },
      askedBy: { botId: "mochi", name: "Mochi", threadIds: ["work"] },
    })]);
    expect(calls).toEqual(["append main"]);
  });

  it("keeps one line per hand-off thread: a follow-up, a consult round or rework into it adds nothing", () => {
    const { main, calls, deps } = fakeStore({ main: { title: "Garden" }, work: { title: "Octopus facts" } });
    postHandedLine(deps, { botId: "sage", threadId: "work", from: MOCHI, text: "Find octopus facts" });
    main.push(person("p1"));
    expect(postHandedLine(deps, { botId: "sage", threadId: "work", from: MOCHI, text: "Check them again" })).toBeUndefined();
    expect(postHandedLine(deps, { botId: "sage", threadId: "work", from: KAI, text: "And from me" })).toBeUndefined();
    expect(calls).toEqual(["append main"]);
  });

  it("folds fresh hand-offs from the same bot with nothing from the person in between into one line with a count", () => {
    const threads = { main: { title: "Garden" }, w1: { title: "One" }, w2: { title: "Two" }, w3: { title: "Three" }, w4: { title: "Four" } };
    const { main, calls, deps } = fakeStore(threads);
    for (const id of ["w1", "w2", "w3", "w4"]) postHandedLine(deps, { botId: "sage", threadId: id, from: MOCHI, text: threads[id as keyof typeof threads].title });
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({
      tool: { name: "Mochi asked me 4 times: Four", nameCode: "chat.notice.askedMeTimes", nameParams: { bot: "Mochi", count: 4, title: "Four" } },
      threadRef: { threadId: "w4", title: "Four" }, askedBy: { botId: "mochi", count: 4, threadIds: ["w1", "w2", "w3", "w4"] },
    });
    expect(calls).toEqual(["append main", "patch main m1", "patch main m1", "patch main m1"]);
    // A follow-up into any thread the folded line covers still adds nothing.
    expect(postHandedLine(deps, { botId: "sage", threadId: "w2", from: MOCHI, text: "again" })).toBeUndefined();
  });

  it("starts a new line once the person wrote, or another bot asks", () => {
    const threads = { main: { title: "Garden" }, w1: { title: "One" }, w2: { title: "Two" }, w3: { title: "Three" } };
    const { main, deps } = fakeStore(threads);
    postHandedLine(deps, { botId: "sage", threadId: "w1", from: MOCHI, text: "One" });
    main.push(person("p1"));
    postHandedLine(deps, { botId: "sage", threadId: "w2", from: MOCHI, text: "Two" });
    postHandedLine(deps, { botId: "sage", threadId: "w3", from: KAI, text: "Three" });
    expect(main.filter((message) => message.askedBy).map((message) => [message.askedBy!.botId, message.threadRef!.threadId])).toEqual([["mochi", "w1"], ["mochi", "w2"], ["kai", "w3"]]);
  });

  it("does not count a bot's or a routine's line as the person's", () => {
    const threads = { main: { title: "Garden" }, w1: { title: "One" }, w2: { title: "Two" } };
    const { main, deps } = fakeStore(threads);
    postHandedLine(deps, { botId: "sage", threadId: "w1", from: MOCHI, text: "One" });
    main.push({ ...person("auto"), automated: true }, { id: "reply", at: 0, role: "bot", kind: "text", text: "Done." });
    postHandedLine(deps, { botId: "sage", threadId: "w2", from: MOCHI, text: "Two" });
    expect(main.filter((message) => message.askedBy)).toHaveLength(1);
  });

  it("writes nothing when the work runs in the main chat, the main chat is archived, or a thread is gone", () => {
    const { calls, deps } = fakeStore({ main: { title: "Garden" }, work: { title: "Work" } });
    expect(postHandedLine(deps, { botId: "sage", threadId: "main", from: MOCHI, text: "x" })).toBeUndefined();
    expect(postHandedLine(deps, { botId: "sage", threadId: "gone", from: MOCHI, text: "x" })).toBeUndefined();
    expect(postHandedLine({ ...deps, mainThread: () => undefined }, { botId: "sage", threadId: "work", from: MOCHI, text: "x" })).toBeUndefined();
    const archived = fakeStore({ main: { title: "Garden", archivedAt: 5 }, work: { title: "Work" } });
    expect(postHandedLine(archived.deps, { botId: "sage", threadId: "work", from: MOCHI, text: "x" })).toBeUndefined();
    expect([...calls, ...archived.calls]).toEqual([]);
  });

  it("finds no main chat while the one the person chose is archived, instead of falling back to another", () => {
    const archived = new Set(["chosen"]);
    expect(handedMainThread({ mainThreadChoice: "chosen" }, (id) => archived.has(id), () => "oldest")).toBeUndefined();
    expect(handedMainThread({ mainThreadChoice: "other" }, (id) => archived.has(id), () => "other")).toBe("other");
    expect(handedMainThread({ mainThreadChoice: "x", mainThreadKept: { id: "chosen", under: "x" } }, (id) => archived.has(id), () => "oldest")).toBeUndefined();
    expect(handedMainThread({}, () => false, () => "first")).toBe("first");
  });

  it("caps what the line says at 60 characters, a sender's title too", () => {
    expect(handedSummary("  Find three\n\noctopus   facts  ")).toBe("Find three octopus facts");
    const long = handedSummary("word ".repeat(40));
    expect([...long].length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
    expect(handedSummary("ignored", "  Octopus   facts ")).toBe("Octopus facts");
    const title = handedSummary("ignored", "T".repeat(200));
    expect([...title].length).toBe(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("never lets a failure in the line stop the hand-off: it is logged", () => {
    const logged: string[] = [];
    expect(() => writeHandedLine(() => { throw new Error("disk full"); }, (line) => logged.push(line))).not.toThrow();
    expect(logged).toEqual(["hand-off line not written: disk full"]);
  });

  it("is never context for the bot's model: not a message, not a replayed tool call, not in a skill review", () => {
    const line = { ...handedLine({ from: MOCHI, summary: "Octopus facts", botId: "sage", threadId: "work", threadTitle: "Octopus facts" }), id: "line", at: 2 } as Message;
    expect(isContextMessage(line)).toBe(false);
    const before = { id: "a", at: 1, role: "user", kind: "text", text: "Hello" } as Message;
    const after = { id: "b", at: 3, role: "bot", kind: "text", text: "Hi" } as Message;
    expect(replayToolCalls([before, line, after], { replayToolHistory: true }, {})).toEqual([]);
    expect(reviewTranscript([before, line, after], { id: "sage", name: "Sage" }, false)).not.toContain("asked me");
  });
});
