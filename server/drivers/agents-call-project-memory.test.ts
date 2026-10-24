import { describe, expect, it, vi } from "vitest";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";

function fixture(ok = true) {
  const receipt = { schema: "openmaus.project-memory.v1", state: "recalled", canonical: false, promoted: false, untrusted_context: true, entries: [] };
  const apiResponse = vi.fn(async () => ({ ok, status: ok ? 200 : 403, body: ok ? receipt : { error: "No current project grant" } }));
  const context: ToolCallContext = { botId: "engineer", threadId: "project-thread", depth: 0, sharedComputers: false, externalRuntime: false,
    client: { api: async () => ({}), apiResponse } };
  return { context, apiResponse, receipt };
}

describe("native project-memory bridge", () => {
  it("uses the existing turn capability without accepting a caller identity", async () => {
    const f = fixture();
    const reply = await callTool("project_memory", { operation: "recall", entry_id: "canary-id" }, f.context);
    expect(f.apiResponse.mock.calls).toEqual([["/api/internal/project-memory", { method: "POST", body: JSON.stringify({ operation: "recall", entryId: "canary-id" }) }]]);
    expect(JSON.parse(reply.text)).toEqual(f.receipt);
  });

  it("retains server scope errors instead of claiming a memory result", async () => {
    const f = fixture(false);
    const reply = await callTool("project_memory", { operation: "remember", kind: "decision", name: "Canary", detail: "Synthetic" }, f.context);
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("No current project grant");
  });

  it("returns field-specific write limits so a refused note can be deliberately summarized", async () => {
    const f = fixture();
    f.context.client.apiResponse = async () => ({ ok: false, status: 400,
      body: { code: "invalid", error: "Invalid project-memory request. detail: at most 600 characters (received 826). Nothing was saved." } });
    const reply = await callTool("project_memory", { operation: "remember", kind: "decision", name: "Schema", detail: "x".repeat(826) }, f.context);
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("detail"); expect(reply.text).toContain("600"); expect(reply.text).toContain("826");
    expect(reply.text).toContain("Nothing was saved");
  });

  it("advertises no identity, project or path overrides and excludes standing runtimes", () => {
    const tool = availableTools(catalogProfileFromEnv({})).find(tool => tool.name === "project_memory")!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const field of ["bot_id", "thread_id", "projectId", "project_id", "cwd", "path", "source"]) expect(tool.inputSchema.properties).not.toHaveProperty(field);
    expect(availableTools(catalogProfileFromEnv({ OMB_EXTERNAL_RUNTIME: "1" })).map(tool => tool.name)).not.toContain("project_memory");
  });

  it("returns measured job coverage through the existing status tool", async () => {
    const f = fixture();
    const usage = { rootId: "job-root", total: { input: 500, output: 20, cachedInput: 400, reportedUsd: null, estimatedUsd: null, unknownCostTurns: 1 },
      coverage: { state: "partial", missingAttempts: 1 }, observations: [{ attemptId: "observed-attempt", costUsd: null }] };
    f.context.client.apiResponse = async () => ({ ok: true, status: 200, body: { assignment: { id: "job-root", status: "failed" }, usage } });
    const result = await callTool("assignment_status", { id: "job-root" }, f.context);
    expect(result.text).toContain('"input":500');
    expect(result.text).toContain('"cachedInput":400');
    expect(result.text).toContain('"missingAttempts":1');
    expect(result.text).toContain('"reportedUsd":null');
    expect(result.text).toContain("missing measurements remain unknown");
  });
});
