import { expect, it, vi } from "vitest";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import type { HarnessClient, Json } from "./agents-client.ts";

function fixture() {
  const response = { ok: true, status: 200, body: { state: "applied", result: { target_bot_id: "target", assignedSkills: ["keep"] } } as Json };
  const api = vi.fn<HarnessClient["api"]>(async () => ({}));
  const apiResponse = vi.fn<HarnessClient["apiResponse"]>(async () => response);
  const context: ToolCallContext = { botId: "chief", threadId: "origin-thread", depth: 0, externalRuntime: false, sharedComputers: false, client: { api, apiResponse } };
  return { response, api, apiResponse, call: (name: string, args: Json) => callTool(name, args, context) };
}

it.each(["share", "assign", "unassign", "transfer_maintainer"])("routes %s with one skill, exact caller identity and a required revision", async (action) => {
  const f = fixture();
  const args = { action, skill_name: "formal-skill", target_bot_id: "target" };
  expect((await f.call("skill_manage", args)).isError).toBe(true);
  expect(f.apiResponse).not.toHaveBeenCalled();
  const result = await f.call("skill_manage", { ...args, base_revision: " revision " });
  expect(result.isError).toBeFalsy();
  expect(result.text).toContain('"assignedSkills":["keep"]');
  expect(f.apiResponse).toHaveBeenCalledTimes(1);
  const [path, init] = f.apiResponse.mock.calls[0]!;
  expect(path).toBe("/api/internal/skills/stage");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(init!.body!)).toEqual({ ...args, base_revision: "revision", fromBotId: "chief", fromThreadId: "origin-thread" });
});

it.each([{ state: "pending", result: {} }, { state: "applied" }, { state: "applied", result: null }])("refuses an unverified management receipt %j", async (body) => {
  const f = fixture();
  f.response.body = body;
  expect((await f.call("skill_manage", { action: "assign", skill_name: "formal-skill", target_bot_id: "target", base_revision: "revision" })).isError).toBe(true);
});

it("returns the server's refusal without claiming the change applied", async () => {
  const f = fixture();
  Object.assign(f.response, { ok: false, status: 403, body: { error: "Chief authority was revoked" } });
  expect(await f.call("skill_manage", { action: "unassign", skill_name: "stale", target_bot_id: "target", base_revision: "revision" }))
    .toEqual({ text: "Chief authority was revoked", isError: true });
});

it("preserves the target listing and its stale-name revisions", async () => {
  const f = fixture();
  const listing = { target_bot_id: "target", assignedSkills: ["missing"], library: [{ name: "missing", in_library: false, assigned: true, management_revision: "revision" }] };
  f.api.mockResolvedValueOnce(listing);
  const result = await f.call("skills_list", { target_bot_id: " target " });
  expect(JSON.parse(result.text)).toEqual(listing);
  const path = f.api.mock.calls[0]![0];
  expect(new URL(path, "http://fixture").searchParams.get("targetBotId")).toBe("target");
});
