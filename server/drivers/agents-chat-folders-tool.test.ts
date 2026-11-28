import { describe, expect, it } from "vitest";

import { callChatFoldersTool } from "./agents-chat-folders-tool.ts";

function context(answer: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    context: { botId: "bot-1", threadId: "t-1", client: { api: async (path: string, init?: { body?: string }) => { calls.push([path, init?.body ? JSON.parse(init.body) : undefined]); return answer; } } } as never,
  };
}

describe("chat_folders arguments", () => {
  it("refuses a missing action and arguments of the wrong type before calling the app", async () => {
    for (const args of [{}, { action: "delete" }, { action: "create" }, { action: "create", name: 3 }, { action: "create", name: "A", emoji: 1 },
      { action: "move" }, { action: "move", folder: 2 }, { action: "move", folder: "A", thread_id: 5 }]) {
      const { calls, context: ctx } = context();
      expect((await callChatFoldersTool(args as never, ctx)).isError, JSON.stringify(args)).toBe(true);
      expect(calls).toEqual([]);
    }
  });

  it("sends its own bot and thread with each action", async () => {
    const list = context({ folders: [{ id: "f-1", name: "Clients", threads: [{ threadId: "t-9", title: "Acme" }] }] });
    expect((await callChatFoldersTool({ action: "list" }, list.context)).text).toBe("Clients (id f-1): #Acme (t-9)");
    expect(list.calls).toEqual([["/api/internal/folders?fromBotId=bot-1&fromThreadId=t-1", undefined]]);
    const move = context({ title: "Acme", folder: null });
    expect((await callChatFoldersTool({ action: "move", folder: "" }, move.context)).text).toBe("Took #Acme out of its folder.");
    expect(move.calls).toEqual([["/api/internal/folders/move", { fromBotId: "bot-1", fromThreadId: "t-1", folder: "" }]]);
  });
});
