import { describe, expect, it, vi } from "vitest";
import { approveWorkflow, executeApprovedWorkflow, proposeWorkflow, verifyWorkflow } from "./approval.ts";

const proposed = { version: 1, steps: [{ kind: "call", id: "check", tool: "MAIL_LIST", input: { folder: "inbox" } }] };
const allowed = new Set(["MAIL_LIST"]);

describe("minimum AI approval boundary", () => {
  it("requires an explicit approved plan and never calls the model on replay", async () => {
    const draft = proposeWorkflow(proposed, allowed);
    const invoke = vi.fn(async () => ({ messages: [] }));
    await expect(executeApprovedWorkflow(draft, allowed, invoke)).rejects.toThrow(/approval/i);
    expect(invoke).not.toHaveBeenCalled();
    const approved = approveWorkflow((await verifyWorkflow(draft, allowed, async () => ({}))).proposal);
    expect((await executeApprovedWorkflow(approved, allowed, invoke)).status).toBe("completed");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed plan or a tool whose grant was revoked", async () => {
    const approved = approveWorkflow((await verifyWorkflow(proposeWorkflow(proposed, allowed), allowed, async () => ({}))).proposal);
    const invoke = vi.fn(async () => ({}));
    await expect(executeApprovedWorkflow({ ...approved, plan: { ...approved.plan, steps: [{ ...approved.plan.steps[0], tool: "MAIL_DELETE" }] } } as typeof approved, allowed, invoke)).rejects.toThrow();
    await expect(executeApprovedWorkflow(approved, new Set(), invoke)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("rejects credential fields and tools that have not been granted", () => {
    expect(() => proposeWorkflow({ version: 1, steps: [{ kind: "call", id: "x", tool: "MAIL_LIST", input: { token: "secret" } }] }, allowed)).toThrow();
    expect(() => proposeWorkflow({ version: 1, steps: [{ kind: "call", id: "x", tool: "MAIL_DELETE", input: {} }] }, allowed)).toThrow();
  });
});

it("requires an explicitly approved read-only tool for automatic pagination", () => {
  const plan = { version: 1, steps: [{ kind: "call", id: "x", tool: "MAIL_LIST", input: {}, pagination: { cursorArg: "cursor", nextPath: "next", itemsPath: "rows", maxPages: 3 } }] };
  expect(() => proposeWorkflow(plan, allowed)).toThrow(/pagination/i);
  expect(() => proposeWorkflow(plan, allowed, new Set(["MAIL_LIST"]))).not.toThrow();
});

it("requires a successful test before a draft can be approved", async () => {
  const draft = proposeWorkflow(proposed, allowed);
  expect(() => approveWorkflow(draft)).toThrow(/test/i);
});
