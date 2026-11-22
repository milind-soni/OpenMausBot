import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WORKFLOW_FILE, type Workflow } from "../../shared/skill-burger/format.ts";
import { librarySkillDirectory, readSkillLibraryIndex } from "../skill-library.ts";
import { listWorkflowSkills, readWorkflowSkill, removeWorkflowSkill, saveWorkflowSkill, workflowSkillsPrompt } from "./store.ts";

const workflow: Workflow = {
  version: 1,
  summary: "Email the weekly sales sheet to Priya",
  args: { recipient: { default: "priya@example.com", label: "recipient email" } },
  steps: [
    { id: "s1", kind: "app", app: "googlesheets", tool: "GOOGLESHEETS_BATCH_GET", label: "Batch get", args: { spreadsheet_id: "1AbC" } },
    { id: "s2", kind: "ai", deterministic: false, label: "Write the body", prompt: "Write it.", input: { $step: "s1" } },
    { id: "s3", kind: "app", app: "gmail", tool: "GMAIL_SEND_EMAIL", label: "Send email", args: { recipient_email: { $arg: "recipient" }, body: { $step: "s2" } } },
  ],
};

const root = () => mkdtempSync(join(tmpdir(), "burger-"));

describe("saved burgers", () => {
  it("saves one click's run as an every-bot workflow skill with its steps beside it", () => {
    const dir = root();
    const saved = saveWorkflowSkill({ workflow, root: dir });
    expect(saved).toMatchObject({ name: "email-the-weekly-sales-sheet-to", summary: workflow.summary, args: ["recipient"] });
    if ("error" in saved) throw new Error(saved.error);
    expect(saved.layers.map((layer) => [layer.kind, layer.app])).toEqual([["app", "googlesheets"], ["ai", undefined], ["app", "gmail"]]);
    const entry = readSkillLibraryIndex(dir)[saved.name]!;
    expect(entry).toMatchObject({ everyBot: true, reviewState: "approved", tags: ["workflow"], source: "skill-burger", files: [WORKFLOW_FILE] });
    expect(JSON.parse(readFileSync(join(librarySkillDirectory(dir, saved.name), WORKFLOW_FILE), "utf8"))).toEqual(workflow);
    expect(readWorkflowSkill(saved.name, dir)?.text).toContain("1. Google Sheets: Batch get");
    expect(listWorkflowSkills(dir).map((skill) => skill.name)).toEqual([saved.name]);
    expect(workflowSkillsPrompt("bot-1", dir)).toContain(`- ${saved.name}: ${workflow.summary} Read`);
  });

  it("refuses a taken or malformed name and a workflow that isn't one", () => {
    const dir = root();
    saveWorkflowSkill({ workflow, name: "sales-email", root: dir });
    expect(saveWorkflowSkill({ workflow, name: "sales-email", root: dir })).toMatchObject({ taken: true });
    expect(saveWorkflowSkill({ workflow, name: "Sales Email", root: dir })).toHaveProperty("error");
    expect(saveWorkflowSkill({ workflow: { ...workflow, steps: [] }, root: dir })).toHaveProperty("error");
    expect(saveWorkflowSkill({ workflow, root: dir })).toMatchObject({ name: "email-the-weekly-sales-sheet-to" });
  });

  it("undoes a save, but never a copy that changed since", () => {
    const dir = root();
    const saved = saveWorkflowSkill({ workflow, root: dir });
    if ("error" in saved) throw new Error(saved.error);
    expect(removeWorkflowSkill(saved.name, "0".repeat(64), dir)).toEqual({ stale: true });
    expect(removeWorkflowSkill(saved.name, saved.sha256, dir)).toEqual({ removed: true });
    expect(listWorkflowSkills(dir)).toEqual([]);
    expect(workflowSkillsPrompt("bot-1", dir)).toBe("");

    const again = saveWorkflowSkill({ workflow, root: dir });
    if ("error" in again) throw new Error(again.error);
    writeFileSync(join(librarySkillDirectory(dir, again.name), WORKFLOW_FILE), "{}");
    expect(listWorkflowSkills(dir)).toEqual([]);
    expect(removeWorkflowSkill(again.name, again.sha256, dir)).toEqual({ stale: true });
  });
});
