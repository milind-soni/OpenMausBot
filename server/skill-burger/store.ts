// Saved burgers live in the shared skills library as ordinary skill folders (SKILL.md + workflow.json), tagged
// "workflow" and on for every bot. They are read here whether or not the library itself is switched on, so a saved
// burger reaches every bot either way; Undo retires the exact copy it saved and refuses one that changed since.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SavedWorkflow } from "../../shared/skill-burger/saved.ts";
import { isSkillName } from "../../shared/skill-md.ts";
import { WORKFLOW_FILE, WORKFLOW_MAX_BYTES, WORKFLOW_TAG, renderWorkflowSkillMd, workflowSchema, workflowSkillName, type Workflow } from "../../shared/skill-burger/format.ts";
import {
  installLibrarySkill, librarySkillDirectory, librarySkillFilePath, librarySkillOptOuts, listLibrarySkills, readSkillLibraryIndex,
  retireLibrarySkill, setLibrarySkillEveryBot, skillsLibraryRoot,
} from "../skill-library.ts";

export const WORKFLOW_SOURCE = "skill-burger";
const PROMPT_MAX_SKILLS = 20;
const PROMPT_MAX_BYTES = 2_000;


export type { SavedWorkflow };

function readWorkflow(name: string, root: string): Workflow | null {
  try {
    const parsed = workflowSchema.safeParse(JSON.parse(readFileSync(join(librarySkillDirectory(root, name), WORKFLOW_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every saved burger whose files are as saved, newest first. */
export function listWorkflowSkills(root: string = skillsLibraryRoot()): SavedWorkflow[] {
  const index = readSkillLibraryIndex(root);
  return listLibrarySkills(root)
    .filter((skill) => skill.enabled && skill.tags?.includes(WORKFLOW_TAG))
    .flatMap((skill) => {
      const workflow = readWorkflow(skill.name, root);
      const entry = index[skill.name];
      if (!workflow || !entry) return [];
      return [{
        name: skill.name, summary: workflow.summary, sha256: entry.sha256, savedAt: entry.importedAt,
        layers: workflow.steps.map((step) => ({ kind: step.kind, label: step.label, ...(step.kind === "app" ? { app: step.app } : {}) })),
        args: Object.keys(workflow.args),
      }];
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function readWorkflowSkill(name: string, root: string = skillsLibraryRoot()): { text: string; workflow: Workflow } | null {
  if (!isSkillName(name) || !readSkillLibraryIndex(root)[name]?.tags?.includes(WORKFLOW_TAG)) return null;
  const workflow = readWorkflow(name, root);
  if (!workflow) return null;
  try {
    return { text: readFileSync(librarySkillFilePath(name, root), "utf8"), workflow };
  } catch {
    return null;
  }
}

/** Saves a draft as a workflow skill on for every bot. `name` is the person's own, or one made from the summary. */
export function saveWorkflowSkill(input: { workflow: Workflow; name?: string; root?: string }): SavedWorkflow | { error: string; taken?: true } {
  const root = input.root ?? skillsLibraryRoot();
  const checked = workflowSchema.safeParse(input.workflow);
  if (!checked.success) return { error: "This run can't be saved as a skill." };
  const workflow = checked.data;
  const body = `${JSON.stringify(workflow, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > WORKFLOW_MAX_BYTES) return { error: "This run is too large to save as a skill." };
  const index = readSkillLibraryIndex(root);
  const asked = input.name?.trim();
  if (asked !== undefined && asked !== "") {
    if (!isSkillName(asked)) return { error: "Use lowercase letters, numbers and hyphens for the name." };
    if (index[asked]) return { error: "That name is taken. Try another.", taken: true };
  }
  const name = asked || workflowSkillName(workflow.summary, new Set(Object.keys(index)));
  const installed = installLibrarySkill({
    name, instructions: renderWorkflowSkillMd(name, workflow), source: WORKFLOW_SOURCE, tags: [WORKFLOW_TAG],
    reviewState: "approved", files: [{ path: WORKFLOW_FILE, content: body }], root,
  });
  if ("error" in installed) return { error: installed.error };
  const everyBot = setLibrarySkillEveryBot(name, true, root);
  if ("error" in everyBot) return { error: everyBot.error };
  return listWorkflowSkills(root).find((saved) => saved.name === name) ?? { error: "The skill was saved but can't be read back." };
}

/** Undo or remove: retires the copy with this hash, so an undo never removes a skill someone changed since. */
export function removeWorkflowSkill(name: string, sha256: string | undefined, root: string = skillsLibraryRoot()): { removed: true } | { stale: true } | { error: string } {
  const entry = readSkillLibraryIndex(root)[name];
  if (!entry?.tags?.includes(WORKFLOW_TAG)) return { stale: true };
  const result = retireLibrarySkill(name, sha256 ?? entry.sha256, root);
  return "retired" in result ? { removed: true } : result;
}

/** The turn's list of saved burgers, for a bot that doesn't already see them through the skills library. */
export function workflowSkillsPrompt(botId: string, root: string = skillsLibraryRoot()): string {
  const optedOut = librarySkillOptOuts(botId);
  const lines: string[] = [];
  let bytes = 0;
  for (const saved of listWorkflowSkills(root)) {
    if (optedOut.has(saved.name) || lines.length >= PROMPT_MAX_SKILLS) continue;
    const line = `- ${saved.name}: ${saved.summary} Read ${JSON.stringify(librarySkillFilePath(saved.name, root))}.`;
    if (bytes + line.length > PROMPT_MAX_BYTES) break;
    bytes += line.length + 1;
    lines.push(line);
  }
  return lines.length
    ? `\n\nSaved workflows (runs the person saved as skills; when one fits the task, read its SKILL.md and do its steps with the values in its workflow.json):\n${lines.join("\n")}`
    : "";
}
