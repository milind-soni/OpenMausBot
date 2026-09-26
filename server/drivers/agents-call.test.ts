import { describe, expect, it, vi } from "vitest";
import { callTool, capResult, toolCallContextFromEnv, type ToolCallContext } from "./agents-call.ts";

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

describe("create_bot", () => {
  it("passes a working folder through to the internal create route", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("create_bot", { name: "Scout", role: "Ops", instructions: "Work.", cwd: "  /tmp/ops  " }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { id: "b1", name: "Scout", section: "Work" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      { path: "/api/internal/create-bot", body: { fromBotId: "bot-voice", fromThreadId: "thread-voice", name: "Scout", role: "Ops", instructions: "Work.", cwd: "/tmp/ops" } },
    ]);
  });
});

describe("propose_profile", () => {
  it("rejects a non-boolean toggle without proposing the valid half", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_profile", { description: "Calmer replies.", notifications: "on" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("propose_profile notifications and speakReplies must be true or false.");
    expect(calls).toEqual([]);
  });

  it("passes boolean toggles through with the other fields", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("propose_profile", { description: "Calmer replies.", notifications: false, speakReplies: true, reason: "Use calmer replies." }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/internal/profile-requests",
        body: {
          fromBotId: "bot-voice",
          fromThreadId: "thread-voice",
          changes: { description: "Calmer replies.", notifications: false, speakReplies: true },
          reason: "Use calmer replies.",
        },
      },
    ]);
  });
});

describe("tool result triage wiring", () => {
  it("offers the triage budget only when the harness mounted it", () => {
    expect(toolCallContextFromEnv({}).triageTokens).toBeUndefined();
    expect(toolCallContextFromEnv({ OMB_TOOL_TRIAGE_TOKENS: "junk" }).triageTokens).toBeUndefined();
    expect(toolCallContextFromEnv({ OMB_TOOL_TRIAGE_TOKENS: "0" }).triageTokens).toBeUndefined();
    expect(toolCallContextFromEnv({ OMB_TOOL_TRIAGE_TOKENS: "-5" }).triageTokens).toBeUndefined();
    expect(toolCallContextFromEnv({ OMB_TOOL_TRIAGE_TOKENS: "6000" }).triageTokens).toBe(6_000);
  });

  it("asks for a summary on the save route only when offered triage", async () => {
    const bodies: { triage?: unknown }[] = [];
    const api = vi.fn(async (_path: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { id: "r-37a58e8d-4411-4a9c-bc1a-00c4278201db" };
    });
    const oversized = "x".repeat(30_000);
    await capResult(oversized, context({ triageTokens: 6_000, client: { api, apiResponse: async () => ({ ok: true, status: 200, body: {} }) } }));
    await capResult(oversized, context({ client: { api, apiResponse: async () => ({ ok: true, status: 200, body: {} }) } }));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ triage: true });
    expect(bodies[1]).not.toHaveProperty("triage");
  });
});
