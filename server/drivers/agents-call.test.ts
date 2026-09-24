import { describe, expect, it } from "vitest";
import { callTool, type ToolCallContext } from "./agents-call.ts";

function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    botId: "bot-voice",
    threadId: "thread-voice",
    depth: 0,
    externalRuntime: false,
    coordinating: false,
    sharedComputers: false,
    client: {
      api: async () => ({}),
      apiResponse: async () => ({ ok: true, status: 200, body: {} }),
    },
    turn: {
      createdThisTurn: 0,
      roomPostsThisTurn: 0,
      threadsOpenedThisTurn: 0,
      memoryRefusalsThisTurn: 0,
      delegationTaskIdsThisTurn: new Set(),
    },
    ...overrides,
  };
}

describe("send_voice_note", () => {
  it("refuses a missing or blank note with the shape a retry needs", async () => {
    for (const args of [{}, { text: "" }, { text: "   " }]) {
      const result = await callTool("send_voice_note", args, context());
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toContain("send_voice_note needs text");
    }
  });

  it("refuses a note over 1000 characters and reports the length", async () => {
    const result = await callTool("send_voice_note", { text: "a".repeat(1001) }, context());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("1000 characters");
    expect(result.text).toContain("1001");
  });

  it("posts the trimmed verbatim note to the harness route", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("send_voice_note", { text: "  Ship it.  " }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Voice note recorded");
    expect(calls).toEqual([
      { path: "/api/internal/voice-note", body: { fromBotId: "bot-voice", fromThreadId: "thread-voice", text: "Ship it." } },
    ]);
  });

  it("surfaces missing voice setup as a tool error, never a thrown turn", async () => {
    const result = await callTool("send_voice_note", { text: "Hello" }, context({
      client: {
        api: async () => { throw new Error("Pick a voice in the agent profile."); },
        apiResponse: async () => ({ ok: false, status: 409, body: { error: "Pick a voice in the agent profile." } }),
      },
    }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Pick a voice in the agent profile.");
  });
});

