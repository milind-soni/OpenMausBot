import { describe, expect, it } from "vitest";
import type { SendTurnInput } from "../../contracts.ts";
import { acpRuntimeFailure, retryWithoutEdu } from "./failure-words.ts";

describe("acpRuntimeFailure: an MCP server that failed to connect at session start", () => {
  it("says the connected apps could not be set up when dsh's composio client fails", () => {
    const error = new Error("Internal error: mcp-client(composio): initial connection or tool synchronization failed (session/new)");
    expect(acpRuntimeFailure(error, "DeepSeek Harness")).toMatchObject({
      message: "Connected apps couldn't be set up, so DeepSeek Harness couldn't start this reply. Try again, or switch this bot to another AI.",
      text: { key: "chat.notice.acpMcpAppsFailed", params: { provider: "DeepSeek Harness" } },
    });
  });

  it("names any other MCP server that could not be set up", () => {
    const error = new Error("mcp-client(github): initial connection or tool synchronization failed");
    expect(acpRuntimeFailure(error, "DeepSeek Harness")).toMatchObject({
      message: "The \"github\" MCP server couldn't be set up, so DeepSeek Harness couldn't start this reply. Try again, or switch this bot to another AI.",
      text: { key: "chat.notice.acpMcpServerFailed", params: { server: "github", provider: "DeepSeek Harness" } },
    });
  });

  it("leaves other errors as they were", () => {
    expect(acpRuntimeFailure(new Error("mcp-client(composio): tool call failed"), "DeepSeek Harness"))
      .toEqual({ message: "mcp-client(composio): tool call failed" });
    expect(acpRuntimeFailure(new Error("Something else broke"), "Grok")).toEqual({ message: "Something else broke" });
  });

  it("keeps the error when the MCP failure is only quoted in other diagnostics", () => {
    const message = "Internal error: model request failed; earlier: mcp-client(composio): initial connection or tool synchronization failed (session/prompt)";
    expect(acpRuntimeFailure(new Error(message), "DeepSeek Harness")).toEqual({ message });
  });

  it("keeps account wording that comes without a message", () => {
    const error = new Error("mcp-client(composio): initial connection or tool synchronization failed");
    const text = { key: "chat.notice.acpNoReason", params: { provider: "DeepSeek Harness" } } as const;
    expect(acpRuntimeFailure(error, "DeepSeek Harness", { text })).toEqual({ message: error.message, text });
  });
});

describe("retryWithoutEdu", () => {
  const edu = { command: "edu", args: ["mcp"], env: {} };
  const failure = new Error("Internal error: mcp-client(edu): initial connection or tool synchronization failed (session/new)");
  const attempt = (error: unknown, turn: SendTurnInput) => {
    const notices: unknown[] = [], retried: SendTurnInput[] = [];
    const handled = retryWithoutEdu(error, turn, { notice: (notice) => notices.push(notice), retry: (next) => async () => { retried.push(next); }, failed: () => {} });
    return { handled, notices, retried };
  };

  it("runs the turn again without the edu server, after one quiet line an hour", () => {
    const turn: SendTurnInput = { threadId: "t-retry-edu", text: "hi", integrations: { edu, agents: edu } };
    const first = attempt(failure, turn);
    expect(first.handled).toBe(true);
    expect(first.notices).toEqual([expect.objectContaining({ text: { key: "chat.notice.eduMemoryFailed" } })]);
    expect(first.retried).toEqual([{ ...turn, integrations: { agents: edu } }]);
    const again = attempt(failure, turn);
    expect(again).toMatchObject({ handled: true, notices: [] });
    expect(again.retried).toHaveLength(1);
  });

  it("leaves other servers, other errors and a turn without edu to fail as before", () => {
    const turn: SendTurnInput = { threadId: "t-retry-other", text: "hi", integrations: { edu } };
    for (const error of [new Error("mcp-client(github): initial connection or tool synchronization failed"), new Error("Internal error: model request failed; earlier: mcp-client(edu): initial connection or tool synchronization failed")]) {
      expect(attempt(error, turn)).toEqual({ handled: false, notices: [], retried: [] });
    }
    expect(attempt(failure, { threadId: "t-retry-none", text: "hi" })).toEqual({ handled: false, notices: [], retried: [] });
    expect(acpRuntimeFailure(failure, "DeepSeek Harness")).toMatchObject({ text: { key: "chat.notice.acpMcpServerFailed", params: { server: "edu" } } });
  });
});
