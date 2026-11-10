import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkflowStore } from "./store.ts";
import { workflowSchemaDigest } from "./binding.ts";
import { createRunLedger } from "./ledger.ts";
import { runApprovedWorkflow } from "./service.ts";

const catalog = ["MAIL_LIST", "REPORT_ITEM"].map((name) => ({ name, inputSchema: { type: "object" } }));
const context = { owner: "owner", botId: "bot", prompt: "Check mail", connectionIds: ["mail-account"], schemaDigest: workflowSchemaDigest(catalog) };
const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("executes an approved plan once for a run and stops a failed step without retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-service-")); folders.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const ledger = createRunLedger(join(dir, "runs.json"));
  const allowed = new Set(["MAIL_LIST", "REPORT_ITEM"]);
  const draft = store.saveDraft("routine-1", "owner", context, { version: 1, steps: [
    { kind: "call", id: "list", tool: "MAIL_LIST", input: {} },
    { kind: "call", id: "report", tool: "REPORT_ITEM", input: {} },
  ] }, allowed);
  await store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}));
  store.approve("routine-1", "owner", context, draft.fingerprint);
  const invoke = vi.fn(async (tool: string) => { if (tool === "REPORT_ITEM") throw new Error("unavailable"); return {}; });
  const result = await runApprovedWorkflow({ routineId: "routine-1", runId: "run-1", owner: "owner", context, store, ledger, catalog, allowed, invoke });
  expect(result.status).toBe("failed");
  expect(result.completed).toEqual(["list"]);
  expect(ledger.status("run-1")).toBe("failed");
  expect(ledger.held("routine-1")).toBe(true);
  ledger.acknowledge("routine-1");
  await expect(runApprovedWorkflow({ routineId: "routine-1", runId: "run-1", owner: "owner", context, store, ledger, catalog, allowed, invoke })).rejects.toThrow(/already/i);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("does not run a verified workflow if its connected-tool permission is revoked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-revoked-")); folders.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const ledger = createRunLedger(join(dir, "runs.json"));
  const allowed = new Set(["MAIL_LIST"]);
  const draft = store.saveDraft("routine-2", "owner", context, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, allowed);
  await store.verify("routine-2", "owner", context, draft.fingerprint, allowed, async () => ({}));
  store.approve("routine-2", "owner", context, draft.fingerprint);
  const invoke = vi.fn(async () => ({}));
  await expect(runApprovedWorkflow({ routineId: "routine-2", runId: "changed-account", owner: "owner", context: { ...context, connectionIds: ["new-account"] }, store, ledger, catalog, allowed, invoke })).rejects.toThrow(/changed/i);
  expect(ledger.status("changed-account")).toBeUndefined();
  const changedOutput = catalog.map((tool) => ({ ...tool, outputSchema: { type: "array" } }));
  await expect(runApprovedWorkflow({ routineId: "routine-2", runId: "changed-output", owner: "owner", context, store, ledger, catalog: changedOutput, allowed, invoke })).rejects.toThrow(/changed/i);
  expect(ledger.status("changed-output")).toBeUndefined();
  await expect(runApprovedWorkflow({ routineId: "routine-2", runId: "run-2", owner: "owner", context, store, ledger, catalog, allowed: new Set(), invoke })).rejects.toThrow(/not granted/i);
  expect(invoke).not.toHaveBeenCalled();
  expect(ledger.status("run-2")).toBe("failed");
});

it("does not run or test the same workflow twice at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-overlap-")); folders.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const ledger = createRunLedger(join(dir, "runs.json"));
  const allowed = new Set(["MAIL_LIST"]);
  const draft = store.saveDraft("routine-1", "owner", context, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, allowed);
  await store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}));
  store.approve("routine-1", "owner", context, draft.fingerprint);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const opts = { routineId: "routine-1", owner: "owner", context, store, ledger, catalog, allowed, invoke: async () => { await gate; return {}; } };
  const running = runApprovedWorkflow({ ...opts, runId: "run-1" });
  await expect(runApprovedWorkflow({ ...opts, runId: "run-2" })).rejects.toThrow(/already running/i);
  await expect(store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}))).rejects.toThrow(/already running/i);
  release();
  expect((await running).status).toBe("completed");
});
