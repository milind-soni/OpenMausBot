import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema, type Workflow, type WorkflowStep } from "../../shared/skill-burger/format.ts";
import { applyEdit, editSchema, insertFix } from "./edit.ts";
import { createExecutors } from "./executors.ts";
import { startRun } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const recordId = "recFresh1234567890";
const literalId = "recFixed1234567890";
const table = { baseId: "appTest12345678901", tableIdOrName: "Tasks" };
const pathSteps: WorkflowStep[] = [
  { id: "s1", kind: "app", app: "airtable", tool: "AIRTABLE_LIST_RECORDS", label: "Find current record", args: { ...table, view: "Current" } },
  {
    id: "s2", kind: "app", app: "airtable", tool: "AIRTABLE_UPDATE_MULTIPLE_RECORDS", label: "Review records",
    args: { ...table, records: [
      { id: { $step: "s1", path: "records.0.id" }, fields: { Reviewed: true, id: "s1" } },
      { id: literalId, fields: { Reviewed: true } },
    ] },
  },
];

it.each(["add_case", "keep_fix"] as const)("%s keeps references under app record IDs pointing at the added steps", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "burger-edit-ids-"));
  roots.push(root);
  const original: Workflow = workflowSchema.parse({
    version: 1, summary: "Review current records", args: {}, steps: [
      { id: "s1", kind: "app", app: "airtable", tool: "AIRTABLE_LIST_RECORDS", label: "Read archived records", args: { ...table, view: "Archived" } },
      ...(mode === "add_case" ? [{
        id: "d1", kind: "decide", label: "Review records", cases: ["review"],
        rules: [{ $step: "s1", path: "records.0.id", op: "exists", case: "review" }],
      }] : []),
      { id: "s2", kind: "file", label: "Write receipt", path: "receipt.txt", content: "reviewed" },
    ],
  });
  const before = structuredClone(pathSteps);
  const changed = mode === "add_case"
    ? applyEdit(original, editSchema.parse({ action: "add_case", decide: { id: "d1" }, case: "review", steps: pathSteps }))
    : insertFix(original, "s2", pathSteps);
  if ("error" in changed) throw new Error(changed.error);
  const saved = saveWorkflowSkill({ workflow: changed, name: "review-records", botIds: [], root });
  if ("error" in saved) throw new Error(saved.error);
  const loaded = readWorkflowSkill(saved.name, root)!;
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const exec = createExecutors({
    botId: "b", cwd: root,
    async internal(kind, path, body) {
      expect([kind, path]).toEqual(["connectors", "/api/internal/connectors/mcp"]);
      const frame = body as { params: { arguments: { tools: Array<{ tool_slug: string; arguments: Record<string, unknown> }> } } };
      const sent = frame.params.arguments.tools[0]!;
      calls.push({ tool: sent.tool_slug, args: sent.arguments });
      const data = sent.tool_slug === "AIRTABLE_LIST_RECORDS"
        ? { records: [{ id: sent.arguments.view === "Current" ? recordId : "recOlder1234567890" }] }
        : { updated: true };
      return { ok: true, body: { result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: sent.tool_slug, response: { successful: true, data } }] } }) }] } } };
    },
  });
  const result = await startRun({ name: saved.name, botId: "b", threadId: "t", sha256: saved.sha256, workflow: loaded.workflow }, {
    exec, events: { started() {}, ended() {} }, save() {},
  });
  expect(result).toMatchObject({ ok: true, status: "ok" });
  expect(calls.map((call) => call.tool)).toEqual(["AIRTABLE_LIST_RECORDS", "AIRTABLE_LIST_RECORDS", "AIRTABLE_UPDATE_MULTIPLE_RECORDS"]);
  expect(calls[2]!.args).toEqual({ ...table, records: [
    { id: recordId, fields: { Reviewed: true, id: "s1" } },
    { id: literalId, fields: { Reviewed: true } },
  ] });
  expect(readFileSync(join(root, "receipt.txt"), "utf8")).toBe("reviewed");
  expect(pathSteps).toEqual(before);
});
