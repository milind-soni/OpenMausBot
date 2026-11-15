import { existsSync } from "node:fs";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import type { ContextBreakdown } from "../shared/context-breakdown.ts";

const answer = {
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 1900, color: "promptBorder", kind: "used" },
    { id: "mcp_tools_deferred", name: "MCP tools (deferred)", tokens: 700, color: "inactive", isDeferred: true, kind: "deferred" },
    { id: "messages", name: "Messages", tokens: 4100, color: "purple", kind: "used" },
    { id: "free_space", name: "Free space", tokens: 194000, color: "promptBorder", kind: "free" },
  ],
  totalTokens: 6000, maxTokens: 200000, isAutoCompactEnabled: false,
  messageBreakdown: { toolCallTokens: 100, toolResultTokens: 3000, attachmentTokens: 0, assistantMessageTokens: 600, userMessageTokens: 400 },
};

async function setup(extraEnv: NodeJS.ProcessEnv) {
  const fixture = await launchVerificationServer({ ...process.env, ...extraEnv }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const control = async (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const bot = (await control("new-bot", "--name", "Context probe")).bot;
  const thread: string = bot.activeTaskId;
  const post = (action: string) => request(`/api/bots/${bot.id}/${action}`, { method: "POST", body: JSON.stringify({ threadId: thread }) }, fixture.info.url);
  const context = () => post("context") as Promise<{ threadId: string; breakdown: ContextBreakdown | null }>;
  const send = async (text: string) => {
    await control("send", "--bot", bot.id, "--task", thread, "--text", text);
    expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
  };
  const settled = async () => expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
  const records = () => (request(`/api/threads/${thread}/messages`, {}, fixture.info.url) as Promise<any>).then((r) => r.messages.filter((m: any) => m.kind === "compaction"));
  const close = async () => { try { await fixture.close(); } finally { expect(existsSync(fixture.info.dataDir)).toBe(false); } };
  return { thread, post, context, send, settled, records, close };
}

it("answers with the engine's own count while its process holds the conversation, and with nothing otherwise", async () => {
  const f = await setup({ FAKE_CLAUDE_CONTEXT_USAGE: JSON.stringify(answer) });
  try {
    expect(await f.context()).toEqual({ threadId: f.thread, breakdown: null });

    await f.send("hello");
    expect(await f.context()).toEqual({
      threadId: f.thread,
      breakdown: {
        tokens: 6000, window: 200000,
        categories: [
          { id: "system_prompt", kind: "used", tokens: 1900 },
          { id: "messages", kind: "used", tokens: 4100 },
          { id: "free_space", kind: "free", tokens: 194000 },
        ],
        messages: { toolCalls: 100, toolResults: 3000, attachments: 0, assistant: 600, user: 400 },
        autoCompact: false,
      },
    });

    await f.post("start-fresh");
    expect(await f.context()).toEqual({ threadId: f.thread, breakdown: null });
  } finally {
    await f.close();
  }
}, 60_000);

it("has no breakdown between a summary of the conversation and the turn that starts the engine on it", async () => {
  const f = await setup({ FAKE_CLAUDE_CONTEXT_USAGE: JSON.stringify(answer) });
  try {
    await f.send("hello");
    expect((await f.context()).breakdown?.tokens).toBe(6000);

    await f.post("compact");
    await f.settled();
    expect(await f.records()).toHaveLength(1);
    // The engine process that read the whole conversation is still there and still answers 6,000.
    expect(await f.context()).toEqual({ threadId: f.thread, breakdown: null });

    await f.send("and now?");
    expect((await f.context()).breakdown?.tokens).toBe(6000);
  } finally {
    await f.close();
  }
}, 60_000);

it("has no breakdown from an engine that does not count its window by category", async () => {
  const f = await setup({});
  try {
    await f.send("hello");
    expect(await f.context()).toEqual({ threadId: f.thread, breakdown: null });
  } finally {
    await f.close();
  }
}, 60_000);
