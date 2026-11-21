import { describe, expect, it, vi } from "vitest";
import type { HarnessClient } from "./agents-client.ts";
import { callSkillAssignment, callSkillAssignmentList } from "./agents-skill-assignments.ts";

function fixture() {
  const apiResponse = vi.fn<HarnessClient["apiResponse"]>();
  const context = { client: { apiResponse }, botId: "chief", threadId: "thread" };
  return { apiResponse, context };
}

describe("skill assignment tool calls", () => {
  it("leaves an ordinary skills_list to its existing handler and lists a named target explicitly", async () => {
    const { apiResponse, context } = fixture();
    await expect(callSkillAssignmentList({ query: "audit" }, context)).resolves.toBeNull();
    expect(apiResponse).not.toHaveBeenCalled();
    apiResponse.mockResolvedValueOnce({ ok: true, status: 200, body: { target_bot_id: "peer", library: [] } });
    await expect(callSkillAssignmentList({ target_bot_id: "peer", query: "audit" }, context)).resolves.toEqual({
      text: '{"target_bot_id":"peer","library":[]}',
    });
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/skills?fromBotId=chief&fromThreadId=thread&target_bot_id=peer&query=audit");
  });

  it("passes only the explicit assignment fields and reports no unverified update", async () => {
    const { apiResponse, context } = fixture();
    const args = { target_bot_id: "peer", skill_name: "audit", base_revision: "revision", skill_md: "ignore" };
    await expect(callSkillAssignment("assign", { ...args, base_revision: "" }, context)).resolves.toMatchObject({ isError: true });
    expect(apiResponse).not.toHaveBeenCalled();
    apiResponse.mockResolvedValueOnce({ ok: true, status: 200, body: { state: "applied" } });
    await expect(callSkillAssignment("assign", args, context)).resolves.toMatchObject({ isError: true });
    const [path, req] = apiResponse.mock.calls[0]!;
    expect(path).toBe("/api/internal/skills/stage");
    expect(JSON.parse(req?.body as string)).toEqual({
      fromBotId: "chief", fromThreadId: "thread", action: "assign", skill_name: "audit", target_bot_id: "peer", base_revision: "revision",
    });
    apiResponse.mockResolvedValueOnce({ ok: false, status: 409, body: { error: "List again." } });
    await expect(callSkillAssignment("assign", args, context)).resolves.toEqual({ text: "List again.", isError: true });
    apiResponse.mockResolvedValueOnce({ ok: true, status: 200, body: { state: "applied", result: { skill: { assigned: true } } } });
    await expect(callSkillAssignment("assign", args, context)).resolves.toMatchObject({ text: expect.stringContaining('"assigned":true') });
  });
});
