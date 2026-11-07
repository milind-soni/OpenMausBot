import { describe, expect, it } from "vitest";
import { acpRuntimeFailure } from "./failure-words.ts";

describe("acpRuntimeFailure: an MCP server that failed to connect at session start", () => {
  it("says the connected apps could not be set up when dsh's composio client fails", () => {
    const error = new Error("Internal error: mcp-client(composio): initial connection or tool synchronization failed (session/new)");
    expect(acpRuntimeFailure(error, "DeepSeek Harness")).toEqual({
      message: "Connected apps couldn't be set up, so DeepSeek Harness couldn't start this reply. Try again, or switch this bot to another AI.",
    });
  });

  it("names any other MCP server that could not be set up", () => {
    const error = new Error("mcp-client(github): initial connection or tool synchronization failed");
    expect(acpRuntimeFailure(error, "DeepSeek Harness").message)
      .toBe("The \"github\" MCP server couldn't be set up, so DeepSeek Harness couldn't start this reply. Try again, or switch this bot to another AI.");
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
