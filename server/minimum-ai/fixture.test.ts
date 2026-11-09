import { expect, it, vi } from "vitest";
import { prepareWorkflow } from "./planning.ts";
import { approveWorkflow, executeApprovedWorkflow, verifyWorkflow } from "./approval.ts";
import { createWorkflowConnector } from "./connector.ts";

it("plans once, then uses a fake connector for repeated runs without AI", async () => {
  const goal = "Find messages and record the unread subjects";
  const proposal = { version: 1, steps: [
    { kind: "call", id: "inbox", tool: "MAIL_LIST", input: {} },
    { kind: "each", id: "unread", from: "inbox.messages", where: { path: "item.unread", equals: true }, steps: [{ kind: "call", id: "record", tool: "REPORT_ITEM", input: { subject: { $ref: "item.subject" } } }] },
  ] };
  const planner = vi.fn(async () => proposal);
  const allowed = new Set(["MAIL_LIST", "REPORT_ITEM"]);
  const draft = await prepareWorkflow(goal, allowed, planner);
  const approved = approveWorkflow((await verifyWorkflow(draft, allowed, async (tool) => tool === "MAIL_LIST" ? { messages: [] } : { ok: true })).proposal);
  const writes: string[] = [];
  const relay = vi.fn(async (message: Record<string, unknown>) => {
    const toResponse = (value: unknown) => ({ status: 200, bytes: new TextEncoder().encode(JSON.stringify(value)), transportSessionId: "fake" });
    if (message.method !== "tools/call") return toResponse({ result: {} });
    const params = message.params as { arguments: { tools: Array<{ tool_slug: string; arguments: { subject?: string } }> } };
    const call = params.arguments.tools[0]!;
    const data = call.tool_slug === "MAIL_LIST" ? { messages: [{ subject: "First", unread: true }, { subject: "Second", unread: false }] } : (writes.push(call.arguments.subject!), { ok: true });
    return toResponse({ id: "minimum-ai-call", result: { content: [{ type: "text", text: JSON.stringify({ data: { results: [{ tool_slug: call.tool_slug, response: { successful: true, data } }] } }) }] } });
  });
  const authorize = vi.fn(async (tool: string) => allowed.has(tool));
  const invoke = createWorkflowConnector({ relay, authorize });
  expect((await executeApprovedWorkflow(approved, allowed, invoke)).status).toBe("completed");
  expect((await executeApprovedWorkflow(approved, allowed, invoke)).status).toBe("completed");
  expect(writes).toEqual(["First", "First"]);
  expect(planner).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(4);
});
