import { describe, expect, it } from "vitest";
import { acpRuntimeFailure } from "./failure-words.ts";

describe("acpRuntimeFailure: an MCP server that failed to connect at session start", () => {
  it("says the connected apps did not connect when dsh's composio client fails", () => {
    const error = new Error("Internal error: mcp-client(composio): initial connection or tool synchronization failed (session/new)");
    expect(acpRuntimeFailure(error, "DeepSeek Harness")).toEqual({
      message: "Connected apps didn't connect, so DeepSeek Harness couldn't start this reply. Try again, or switch this bot to another AI.",
    });
  });

  it("names any other MCP server that failed to connect", () => {
    const error = new Error("mcp-client(github): initial connection or tool synchronization failed");
    expect(acpRuntimeFailure(error, "DeepSeek Harness").message)
      .toBe("The \"github\" MCP server didn't connect, so DeepSeek Harness couldn't start this reply. Try again, or switch this bot to another AI.");
  });

  it("leaves other errors as they were", () => {
    expect(acpRuntimeFailure(new Error("mcp-client(composio): tool call failed"), "DeepSeek Harness"))
      .toEqual({ message: "mcp-client(composio): tool call failed" });
    expect(acpRuntimeFailure(new Error("Something else broke"), "Grok")).toEqual({ message: "Something else broke" });
  });
});
