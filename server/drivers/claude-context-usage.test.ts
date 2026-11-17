import { describe, expect, it } from "vitest";
import { claudeContextBreakdown, claudeContextUsage } from "./claude-context-usage.ts";

// The answer Claude Code 2.1.325 gives to get_context_usage, without the fields this module does not read.
const answer = {
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 1929, color: "promptBorder", kind: "used" },
    { id: "system_tools", name: "System tools", tokens: 8165, color: "inactive", kind: "used" },
    { id: "system_tools_deferred", name: "System tools (deferred)", tokens: 13263, color: "inactive", isDeferred: true, kind: "deferred" },
    { id: "memory_files", name: "Memory files", tokens: 640, color: "claude", kind: "used" },
    { id: "skills", name: "Skills", tokens: 2064, color: "warning", kind: "used" },
    { id: "messages", name: "Messages", tokens: 5200, color: "purple", kind: "used" },
    { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33000, color: "inactive", kind: "buffer" },
    { id: "free_space", name: "Free space", tokens: 949002, color: "promptBorder", kind: "free" },
  ],
  totalTokens: 17998, maxTokens: 1000000, rawMaxTokens: 1000000, percentage: 2, model: "claude-opus-5-5",
  autoCompactThreshold: 967000, isAutoCompactEnabled: true,
  messageBreakdown: {
    toolCallTokens: 900, toolResultTokens: 3100, attachmentTokens: 0, assistantMessageTokens: 700, userMessageTokens: 500,
    redirectedContextTokens: 0, unattributedTokens: 0, toolCallsByType: [], attachmentsByType: [],
  },
  apiUsage: null,
};
const breakdown = {
  tokens: 17998, window: 1000000,
  categories: [
    { id: "system_prompt", kind: "used", tokens: 1929 },
    { id: "system_tools", kind: "used", tokens: 8165 },
    { id: "memory_files", kind: "used", tokens: 640 },
    { id: "skills", kind: "used", tokens: 2064 },
    { id: "messages", kind: "used", tokens: 5200 },
    { id: "autocompact_buffer", kind: "buffer", tokens: 33000 },
    { id: "free_space", kind: "free", tokens: 949002 },
  ],
  messages: { toolCalls: 900, toolResults: 3100, attachments: 0, assistant: 700, user: 500 },
  autoCompact: true, autoCompactAt: 967000,
};

function harness(delivered = true) {
  const written: any[] = [];
  const context = claudeContextUsage(async (frame) => { written.push(frame); return delivered; });
  const answered = (response: Record<string, unknown>) =>
    context.frame({ type: "control_response", response: { request_id: written.at(-1).request_id, ...response } });
  return { context, written, answered };
}

describe("claudeContextBreakdown", () => {
  it("keeps the engine's rows and leaves out the tool schemas held outside the window", () => {
    expect(claudeContextBreakdown(answer)).toEqual(breakdown);
  });

  it("reports no compaction threshold when the engine does not compact by itself", () => {
    const { messageBreakdown: _parts, ...rest } = answer;
    expect(claudeContextBreakdown({ ...rest, isAutoCompactEnabled: false })).toEqual({
      tokens: breakdown.tokens, window: breakdown.window, categories: breakdown.categories, autoCompact: false,
    });
  });

  it("gives nothing rather than a partial count", () => {
    expect(claudeContextBreakdown(null)).toBeNull();
    expect(claudeContextBreakdown({ ...answer, maxTokens: 0 })).toBeNull();
    expect(claudeContextBreakdown({ ...answer, categories: [{ name: "Messages", tokens: 5200, kind: "used" }] })).toBeNull();
    expect(claudeContextBreakdown({ ...answer, categories: [{ id: "messages", tokens: "many", kind: "used" }] })).toBeNull();
    expect(claudeContextBreakdown({ ...answer, categories: [answer.categories[2]] })).toBeNull();
  });
});

describe("claudeContextUsage", () => {
  it("asks for the summary count and resolves with the CLI's answer", async () => {
    const { context, written, answered } = harness();
    const reading = context.read();
    expect(written).toEqual([{ type: "control_request", request_id: "context-usage-1", request: { subtype: "get_context_usage", detail: "summary" } }]);
    expect(answered({ subtype: "success", response: answer })).toBe(true);
    await expect(reading).resolves.toEqual(breakdown);
    expect(answered({ subtype: "success", response: answer })).toBe(true);
  });

  it("leaves every frame that is not its own answer to the driver", () => {
    const { context } = harness();
    void context.read();
    expect(context.frame({ type: "control_response", response: { subtype: "success", request_id: "other", response: answer } })).toBe(false);
    expect(context.frame({ type: "control_request", request_id: "context-usage-1", request: { subtype: "elicitation" } })).toBe(false);
    expect(context.frame({ type: "assistant" })).toBe(false);
  });

  it("has no breakdown from a CLI that does not know the request", async () => {
    const { context, answered } = harness();
    const reading = context.read();
    answered({ subtype: "error", error: "Unsupported control request subtype: get_context_usage", error_code: "unsupported_request" });
    await expect(reading).resolves.toBeNull();
  });

  it("has no breakdown when the request never reached the CLI, the CLI closed, or the caller stopped waiting", async () => {
    await expect(harness(false).context.read()).resolves.toBeNull();

    const closing = harness();
    const open = closing.context.read();
    closing.context.close();
    await expect(open).resolves.toBeNull();

    const waiting = harness();
    const stop = new AbortController();
    const abandoned = waiting.context.read(stop.signal);
    stop.abort();
    await expect(abandoned).resolves.toBeNull();
    // The late answer is still its own to swallow, so the driver never logs it.
    expect(waiting.answered({ subtype: "success", response: answer })).toBe(true);
    await expect(waiting.context.read(stop.signal)).resolves.toBeNull();
    expect(waiting.written).toHaveLength(1);
  });
});
