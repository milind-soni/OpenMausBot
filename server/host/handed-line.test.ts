import { describe, expect, it } from "vitest";

import { replayToolCalls } from "../context-rebuild.ts";
import { isContextMessage } from "../delta-context.ts";
import type { Message } from "../store.ts";
import { handedLine, handedSummary, postHandedLine, type HandedLineDeps } from "./handed-line.ts";

function fakeStore(threads: Record<string, { title: string; unread?: boolean }>) {
  const appended: Array<{ threadId: string; message: Omit<Message, "id" | "at"> }> = [];
  const patched: Array<{ botId: string; threadId: string; patch: Record<string, unknown> }> = [];
  const store = {
    taskByThread: (_botId: string, threadId: string) => threads[threadId] ? { threadId, ...threads[threadId] } : null,
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => { appended.push({ threadId, message }); return { ...message, id: `m${appended.length}`, at: 1 }; },
    patchTask: (botId: string, threadId: string, patch: Record<string, unknown>) => { patched.push({ botId, threadId, patch }); return null; },
  } as unknown as HandedLineDeps["store"];
  return { store, appended, patched };
}

describe("the hand-off line in a helper's main chat", () => {
  it("says who asked and for what, opens the hand-off thread, and marks the main chat unread", () => {
    const { store, appended, patched } = fakeStore({ main: { title: "Garden" }, work: { title: "Octopus facts" } });
    const id = postHandedLine({ store, mainThread: () => "main", language: () => undefined },
      { botId: "sage", threadId: "work", from: "Mochi", text: "Find three octopus facts", title: "Octopus facts" });
    expect(id).toBe("m1");
    expect(appended).toEqual([{ threadId: "main", message: {
      role: "bot", kind: "activity",
      tool: { name: "Mochi asked me: Octopus facts", ok: true, nameCode: "chat.notice.askedMe", nameParams: { bot: "Mochi", title: "Octopus facts" } },
      threadRef: { botId: "sage", threadId: "work", title: "Octopus facts" },
    } }]);
    expect(patched).toEqual([{ botId: "sage", threadId: "main", patch: { unread: true } }]);
  });

  it("writes the line in the main chat's language", () => {
    const { store } = fakeStore({ main: { title: "Garden" }, work: { title: "Octopus facts" } });
    const asked: string[] = [];
    postHandedLine({ store, mainThread: () => "main", language: (threadId) => { asked.push(threadId); return undefined; } },
      { botId: "sage", threadId: "work", from: "Mochi", text: "Octopus facts" });
    expect(asked).toEqual(["main"]);
  });

  it("leaves nothing when the work runs in the main chat itself, or either thread is gone", () => {
    const { store, appended, patched } = fakeStore({ main: { title: "Garden" }, work: { title: "Work" } });
    const deps = { store, mainThread: () => "main", language: () => undefined };
    expect(postHandedLine(deps, { botId: "sage", threadId: "main", from: "Mochi", text: "x" })).toBeUndefined();
    expect(postHandedLine(deps, { botId: "sage", threadId: "gone", from: "Mochi", text: "x" })).toBeUndefined();
    expect(postHandedLine({ ...deps, mainThread: () => undefined }, { botId: "sage", threadId: "work", from: "Mochi", text: "x" })).toBeUndefined();
    expect(postHandedLine({ ...deps, mainThread: () => "missing" }, { botId: "sage", threadId: "work", from: "Mochi", text: "x" })).toBeUndefined();
    expect(appended).toEqual([]);
    expect(patched).toEqual([]);
  });

  it("says the request on one line, cut short, when the sender gave no title", () => {
    expect(handedSummary("  Find three\n\noctopus   facts  ")).toBe("Find three octopus facts");
    const long = handedSummary("word ".repeat(40));
    expect([...long].length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
    expect(handedSummary("ignored", "  Octopus   facts ")).toBe("Octopus facts");
  });

  it("is never context for the bot's model: not a message, not a replayed tool call", () => {
    const line = { ...handedLine({ from: "Mochi", summary: "Octopus facts", botId: "sage", threadId: "work", threadTitle: "Octopus facts" }), id: "line", at: 2 } as Message;
    expect(isContextMessage(line)).toBe(false);
    const before = { id: "a", at: 1, role: "user", kind: "text", text: "Hello" } as Message;
    const after = { id: "b", at: 3, role: "bot", kind: "text", text: "Hi" } as Message;
    expect(replayToolCalls([before, line, after], { replayToolHistory: true }, {})).toEqual([]);
  });
});
