import { describe, expect, it } from "vitest";
import { acpBackgroundWork } from "./background.ts";

const thread = "test-thread";
const capable = { agentCapabilities: { sessionCapabilities: { close: {}, delete: {}, fork: {} } } };

describe("ACP background work", () => {
  it("counts only a turn's own updates as a woken turn, never a title, usage or command list", () => {
    const work = acpBackgroundWork(["test"]);
    for (const kind of ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]) {
      expect(work.wakes({ sessionUpdate: kind })).toBe(true);
    }
    expect(work.wakes({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": null } })).toBe(true);
    expect(work.wakes({ sessionUpdate: "session_info_update", title: "Build the app" })).toBe(false);
    expect(work.wakes({ sessionUpdate: "usage_update", used: 10, size: 100 })).toBe(false);
    expect(work.wakes({ sessionUpdate: "available_commands_update", availableCommands: [] })).toBe(false);
    expect(work.wakes({ sessionUpdate: "config_option_update" })).toBe(false);
    expect(work.wakes(undefined)).toBe(false);
  });

  it("forks, deletes the original and closes the fork; later turns resume the fork", async () => {
    const work = acpBackgroundWork(["test"]);
    const calls: string[] = [];
    const request = async (method: string, params: any) => {
      calls.push(`${method} ${params.sessionId}`);
      return method === "session/fork" ? { sessionId: `${params.sessionId}-f` } : {};
    };
    await work.end(thread, { sessionId: "s1", cwd: "/w", initResult: capable }, request);
    expect(calls).toEqual(["session/fork s1", "session/delete s1", "session/close s1-f"]);
    expect(work.resumeCursor(thread, "s1", null)).toBe("s1-f");
    expect(acpBackgroundWork(["test"]).resumeCursor(thread, "s1", null)).toBe("s1-f");
    expect(acpBackgroundWork(["another-instance"]).resumeCursor(thread, "s1", null)).toBe("s1");
    expect(work.resumeCursor("another-thread", "s1", null)).toBe("s1");
    expect(work.resumeCursor(thread, undefined, "s1")).toBe("s1-f");
    expect(work.resumeCursor(thread, undefined, "other")).toBeNull();
    expect(work.resumeCursor(thread, "other", "s1")).toBe("other");
    // An ended session is never forked again by a late update.
    await work.end(thread, { sessionId: "s1", cwd: "/w", initResult: capable }, request);
    expect(calls).toHaveLength(3);
    await work.end(thread, { sessionId: "s1-f", cwd: "/w", initResult: capable }, request);
    expect(work.resumeCursor(thread, "s1", null)).toBe("s1-f-f");
  });

  it("keeps the fork when the original session's delete response is lost", async () => {
    const scope = ["lost-response"];
    const requests: string[] = [];
    await acpBackgroundWork(scope).end(thread, { sessionId: "s1", cwd: "/w", initResult: capable }, async (method, params: any) => {
      requests.push(`${method} ${params.sessionId}`);
      if (method === "session/fork") return { sessionId: "s1-f" };
      if (method === "session/delete") throw new Error("connection lost");
      return {};
    });
    expect(requests).toEqual(["session/fork s1", "session/delete s1", "session/close s1-f"]);
    expect(acpBackgroundWork(scope).resumeCursor(thread, "s1", null)).toBe("s1-f");
  });

  it("does nothing when the agent cannot fork and delete, and keeps the session when the delete fails", async () => {
    const work = acpBackgroundWork(["test"]);
    const calls: string[] = [];
    await work.end(thread, { sessionId: "s1", cwd: "/w", initResult: { agentCapabilities: { sessionCapabilities: { close: {} } } } },
      async (method: string, params: any) => { calls.push(`${method} ${params.sessionId}`); return {}; });
    expect(calls).toEqual([]);

    calls.length = 0;
    await work.end(thread, { sessionId: "s2", cwd: "/w", initResult: capable }, async (method: string, params: any) => {
      calls.push(`${method} ${params.sessionId}`);
      if (method === "session/delete" && params.sessionId === "s2") throw Object.assign(new Error("busy"), { code: -32603 });
      return method === "session/fork" ? { sessionId: "s2-f" } : {};
    });
    expect(calls).toEqual(["session/fork s2", "session/delete s2", "session/delete s2-f"]);
    expect(work.resumeCursor(thread, "s2", null)).toBe("s2");
  });
});
