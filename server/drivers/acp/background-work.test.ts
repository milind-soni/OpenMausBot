import { describe, expect, it } from "vitest";
import { closeEndsBackgroundWork, WAKE_GRACE_MS } from "./background-work.ts";

const capable = { agentCapabilities: { sessionCapabilities: { close: {} } } };

describe("close-ends background work", () => {
  it("counts only a turn's own updates as a woken turn", () => {
    const work = closeEndsBackgroundWork();
    for (const kind of ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]) {
      expect(work.wakes({ sessionUpdate: kind })).toBe(true);
    }
    for (const kind of ["session_info_update", "usage_update", "available_commands_update", "config_option_update"]) {
      expect(work.wakes({ sessionUpdate: kind })).toBe(false);
    }
    expect(work.wakes(undefined)).toBe(false);
  });

  it("takes an update that trails a turn of ours as that turn's tail, not a wake", () => {
    const work = closeEndsBackgroundWork();
    expect(work.wakes({ sessionUpdate: "tool_call_update" }, 0)).toBe(false);
    expect(work.wakes({ sessionUpdate: "agent_message_chunk" }, WAKE_GRACE_MS - 1)).toBe(false);
    expect(work.wakes({ sessionUpdate: "agent_message_chunk" }, WAKE_GRACE_MS)).toBe(true);
    expect(work.wakes({ sessionUpdate: "agent_message_chunk" })).toBe(true);
  });

  it("closes the session, forgets its live id, and resumes the same id", async () => {
    const work = closeEndsBackgroundWork();
    const calls: string[] = [];
    const session = { sessionId: "s1" as string | null, cwd: "/w", initResult: capable };
    await work.end(session, async (method: string, params: any) => { calls.push(`${method} ${params.sessionId}`); return {}; });
    expect(calls).toEqual(["session/close s1"]);
    expect(session.sessionId).toBeNull();
    expect(work.resumeCursor(undefined, null, session)).toBe("s1");
    expect(work.resumeCursor("other", null, session)).toBe("other");
    expect(work.resumeCursor(undefined, "live", session)).toBeNull();
    expect(work.resumeCursor(undefined, null, {})).toBeNull();
  });

  it("reports it could not end the work when the agent cannot close sessions, and keeps the session when the close fails", async () => {
    const work = closeEndsBackgroundWork();
    const calls: string[] = [];
    const noClose = { sessionId: "s1" as string | null, cwd: "/w", initResult: { agentCapabilities: { sessionCapabilities: {} } } };
    expect(await work.end(noClose, async (method: string) => { calls.push(method); return {}; })).toBe(false);
    expect(calls).toEqual([]);
    expect(noClose.sessionId).toBe("s1");

    const failing = { sessionId: "s2" as string | null, cwd: "/w", initResult: capable };
    expect(await work.end(failing, async () => { throw new Error("busy"); })).toBe(false);
    expect(failing.sessionId).toBe("s2");
    expect(work.resumeCursor(undefined, null, failing)).toBeNull();
  });

  it("retries a failed close once, and reports when the work could not be ended", async () => {
    const work = closeEndsBackgroundWork();
    let attempts = 0;
    const flaky = { sessionId: "s3" as string | null, cwd: "/w", initResult: capable };
    expect(await work.end(flaky, async () => { if (++attempts === 1) throw new Error("busy"); return {}; })).toBe(true);
    expect(attempts).toBe(2);
    expect(flaky.sessionId).toBeNull();

    let tries = 0;
    const stuck = { sessionId: "s4" as string | null, cwd: "/w", initResult: capable };
    expect(await work.end(stuck, async () => { tries++; throw new Error("busy"); })).toBe(false);
    expect(tries).toBe(2);
  });
});
