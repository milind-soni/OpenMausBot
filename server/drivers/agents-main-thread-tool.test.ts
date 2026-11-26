import { describe, expect, it } from "vitest";

import type { ToolCallContext } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";
import { callSetMainThreadTool } from "./agents-main-thread-tool.ts";

async function run(args: Json) {
  const sent: unknown[] = [];
  const context: ToolCallContext = {
    botId: "bot-a", threadId: "thread-here", externalRuntime: false, sharedComputers: false,
    client: {
      api: async (_path, init) => { sent.push(JSON.parse(String(init?.body))); return { title: "Daily" }; },
      apiResponse: async () => ({ ok: true, status: 200, body: {} }),
    },
  };
  return { result: await callSetMainThreadTool(args, context), sent };
}

describe("set_main_thread", () => {
  it.each([{ thread_id: 42 }, { clear: "true" }])("refuses %j instead of choosing this thread", async (args) => {
    const { result, sent } = await run(args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^set_main_thread needs /);
    expect(sent).toEqual([]);
  });

  it.each([{}, { thread_id: null }])("defaults to this thread when thread_id is %j", async (args) => {
    const { result, sent } = await run(args);
    expect(result.isError).toBeUndefined();
    expect(sent).toEqual([{ fromBotId: "bot-a", fromThreadId: "thread-here" }]);
  });

  it("sends the chosen thread", async () => {
    const { sent } = await run({ thread_id: " thread-daily " });
    expect(sent).toEqual([{ fromBotId: "bot-a", fromThreadId: "thread-here", mainThreadId: "thread-daily" }]);
  });
});
