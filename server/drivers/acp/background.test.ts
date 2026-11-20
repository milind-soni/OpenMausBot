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
    expect(await work.end(thread, { sessionId: "s1", cwd: "/w", initResult: capable }, request)).toBe(true);
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
    const session = { sessionId: "s1", cwd: "/w", initResult: capable };
    const work = acpBackgroundWork(scope);
    expect(await work.end(thread, session, async (method, params: any) => {
      requests.push(`${method} ${params.sessionId}`);
      if (method === "session/fork") return { sessionId: "s1-f" };
      if (method === "session/delete") throw new Error("connection lost");
      return {};
    })).toBe(false);
    expect(requests).toEqual(["session/fork s1", "session/delete s1", "session/close s1-f"]);
    expect(acpBackgroundWork(scope).resumeCursor(thread, "s1", null)).toBe("s1-f");
    expect(await work.end(thread, session, async (method, params: any) => {
      requests.push(`${method} ${params.sessionId}`);
      throw Object.assign(new Error("invalid session"), { code: -32602 });
    })).toBe(false);
    const restarted = acpBackgroundWork(scope);
    expect(restarted.resumeCursor(thread, "s1", null)).toBe("s1-f");
    expect(await restarted.end(thread, session, async (method, params: any) => {
      requests.push(`${method} ${params.sessionId}`);
      return {};
    })).toBe(true);
    expect(requests.slice(3)).toEqual(["session/delete s1", "session/delete s1"]);
  });

  it("follows long chains and uses the requested cursor if the chain cycles", async () => {
    const work = acpBackgroundWork(["long-chain"]);
    for (let index = 0; index < 65; index++) {
      await work.end(thread, { sessionId: `s${index}`, cwd: "/w", initResult: capable }, async (method) =>
        method === "session/fork" ? { sessionId: `s${index + 1}` } : {});
    }
    expect(work.resumeCursor(thread, "s0", null)).toBe("s65");
    await work.end(thread, { sessionId: "s65", cwd: "/w", initResult: capable }, async (method) =>
      method === "session/fork" ? { sessionId: "s0" } : {});
    expect(work.resumeCursor(thread, "s0", null)).toBe("s0");
  });

  it("reports unconfirmed cleanup when capabilities are missing or deletion is refused", async () => {
    const work = acpBackgroundWork(["test"]);
    const calls: string[] = [];
    for (const sessionCapabilities of [{ fork: {} }, { delete: {} }]) {
      expect(await work.end(thread, { sessionId: "s3", cwd: "/w", initResult: { agentCapabilities: { sessionCapabilities } } },
        async (method: string, params: any) => { calls.push(`${method} ${params.sessionId}`); return {}; })).toBe(false);
    }
    expect(calls).toEqual([]);

    calls.length = 0;
    expect(await work.end(thread, { sessionId: "s2", cwd: "/w", initResult: capable }, async (method: string, params: any) => {
      calls.push(`${method} ${params.sessionId}`);
      if (method === "session/delete" && params.sessionId === "s2") throw Object.assign(new Error("busy"), { code: -32603 });
      return method === "session/fork" ? { sessionId: "s2-f" } : {};
    })).toBe(false);
    expect(calls).toEqual(["session/fork s2", "session/delete s2", "session/delete s2-f"]);
    expect(work.resumeCursor(thread, "s2", null)).toBe("s2");
  });

  it("reports unconfirmed cleanup when forking fails or returns an invalid cursor", async () => {
    const work = acpBackgroundWork(["bad-fork"]);
    const session = { sessionId: "s1", cwd: "/w", initResult: capable };
    expect(await work.end(thread, session, async () => { throw new Error("cannot fork"); })).toBe(false);
    expect(await work.end(thread, session, async () => ({ sessionId: "s1" }))).toBe(false);
  });
});
