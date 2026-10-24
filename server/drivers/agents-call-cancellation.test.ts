import { describe, expect, it, vi } from "vitest";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";

describe("Chief job cancellation tool", () => {
  const context = (externalRuntime = false) => {
    const snapshot = { rootId: "root-1", sourceBotId: "chief", sourceThreadId: "source", requestMessageId: "request-1",
      generation: "root-1", treeVersion: "v1", activeLeafId: "leaf", activeTurnId: null, executionId: null };
    const apiResponse = vi.fn(async (path: string, _init?: RequestInit) => ({ ok: true, status: 200,
      body: path.endsWith("/cancel") ? { rootId: "root-1", state: "cancelled", stoppedIds: ["root-1"], activeIds: [], errors: [] } : snapshot }));
    const ctx: ToolCallContext = { botId: "chief", threadId: "command", depth: 0, externalRuntime, sharedComputers: false,
      client: { api: async () => ({}), apiResponse } };
    return { ctx, apiResponse, snapshot };
  };

  it("takes an exact native job snapshot before cancelling it", async () => {
    const f = context();
    const result = await callTool("cancel_job", { job_id: "root-1" }, f.ctx);
    expect(result.isError).toBeFalsy();
    expect(f.apiResponse.mock.calls).toEqual([
      ["/api/internal/jobs/root-1/cancellation"],
      ["/api/internal/jobs/root-1/cancel", { method: "POST", body: JSON.stringify(f.snapshot) }],
    ]);
    expect(result.text).toContain("Partial results");
  });

  it("refuses malformed identities and standing external runtimes without any request", async () => {
    for (const [external, args] of [[false, {}], [false, { job_id: "../root" }], [true, { job_id: "root-1" }]] as const) {
      const f = context(external);
      expect((await callTool("cancel_job", args, f.ctx)).isError).toBe(true);
      expect(f.apiResponse).not.toHaveBeenCalled();
    }
  });

  it("renders exact source job identities from the existing status tool", async () => {
    const f = context();
    f.ctx.client.apiResponse = async () => ({ ok: true, status: 200, body: { outstanding: [], jobs: [{ jobId: "root-1", title: "Original work", status: "waiting", threadId: "source" }] } });
    expect((await callTool("assignment_status", {}, f.ctx)).text).toContain("root-1: Original work");
  });

  it("keeps process uncertainty explicit even when the assignment record is cancelled", async () => {
    const f = context();
    f.ctx.client.apiResponse = async () => ({ ok: true, status: 200, body: { assignment: { id: "child-1", rootId: "root-1", status: "cancelled", stopUnconfirmed: true } } });
    const result = await callTool("assignment_status", { id: "child-1" }, f.ctx);
    expect(result.text).toContain("local stop unconfirmed");
    expect(result.text).toContain("Do not report this job stopped or start replacement work");
    expect(result.text).not.toContain("result resumes you on its own");
  });

  it("advertises cancellation only to native Chiefs", () => {
    const names = (env: NodeJS.ProcessEnv) => availableTools(catalogProfileFromEnv(env)).map(t => t.name);
    expect(names({ OMB_CHIEF_OF_STAFF: "1" })).toContain("cancel_job");
    expect(names({})).not.toContain("cancel_job");
    expect(names({ OMB_CHIEF_OF_STAFF: "1", OMB_EXTERNAL_RUNTIME: "1" })).not.toContain("cancel_job");
  });
});
