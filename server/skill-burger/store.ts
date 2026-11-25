// Saved burgers are ordinary skill folders (SKILL.md + workflow.json) in the shared skills library, tagged "workflow" and
// on for every bot: whoever saves one, every chat and every bot can use it. They are listed to every bot whether or not
// the library is switched on. Undo, rename and remove act on the exact copy they saw and refuse one that changed since.
// Burgers once kept as one bot's own skills move into the library once (migrateBotBurgers).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { burgerBotOf, burgerSource, isBurgerSource, type SavedWorkflow } from "../../shared/skill-burger/saved.ts";
import { isSkillName } from "../../shared/skill-md.ts";
import { caseOf, WORKFLOW_FILE, WORKFLOW_MAX_BYTES, WORKFLOW_TAG, renderWorkflowSkillMd, workflowSchema, workflowSkillName, type Workflow } from "../../shared/skill-burger/format.ts";
import {
  installLibrarySkill, librarySkillDirectory, librarySkillFilePath, librarySkillOptOuts, listLibrarySkills, readSkillLibraryIndex,
  retireLibrarySkill, setLibrarySkillEveryBot, skillsLibraryRoot,
} from "../skill-library.ts";
import { listSkills, readManifest, removeSkill, skillDirectory } from "../skills.ts";

export type { SavedWorkflow };

const PROMPT_MAX_SKILLS = 20;
const PROMPT_MAX_BYTES = 2_000;

/** Skill Burgers are on unless `features.skillBurger` is false; off, saved ones stay where they are. */
export function skillBurgerEnabled(cfg: { features?: { skillBurger?: boolean } }): boolean {
  return cfg.features?.skillBurger !== false;
}

/** Where a saved burger is: the shared library, or (saved before burgers were for every chat, until moved) one bot's own. */
export type BurgerPlace = { botId: string } | { everyChat: true };
type Failure = { error: string; taken?: true };

function parsed(path: string | null): Workflow | null {
  if (!path) return null;
  try {
    const checked = workflowSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return checked.success ? checked.data : null;
  } catch {
    return null;
  }
}

function botFolder(botId: string, name: string): string | null {
  const entry = readManifest(botId)[name];
  return entry && isBurgerSource(entry.source) ? skillDirectory(botId, name, entry) : null;
}

const revision = (instructionSha256: string, workflow: Workflow) => createHash("sha256").update(instructionSha256).update("\0").update(JSON.stringify(workflow)).digest("hex");

function readAt(place: BurgerPlace, name: string, root: string): { workflow: Workflow; sha256: string; instructionSha256: string; botId?: string } | null {
  if (!isSkillName(name)) return null;
  if ("everyChat" in place) {
    const entry = readSkillLibraryIndex(root)[name];
    if (!entry?.tags?.includes(WORKFLOW_TAG)) return null;
    const workflow = parsed(join(librarySkillDirectory(root, name), WORKFLOW_FILE));
    return workflow ? { workflow, sha256: revision(entry.sha256, workflow), instructionSha256: entry.sha256, botId: burgerBotOf(entry.source) } : null;
  }
  const folder = botFolder(place.botId, name);
  const workflow = parsed(folder && join(folder, WORKFLOW_FILE));
  const entry = readManifest(place.botId)[name];
  return workflow && entry ? { workflow, sha256: revision(entry.sha256, workflow), instructionSha256: entry.sha256, botId: place.botId } : null;
}

const listed = (name: string, workflow: Workflow, sha256: string, savedAt: string, botId: string | undefined): SavedWorkflow => ({
  name, summary: workflow.summary, sha256, savedAt, ...(botId ? { botId } : {}),
  layers: workflow.steps.map((step) => { const on = caseOf(step); return { id: step.id, kind: step.kind, label: step.label, ...(step.kind === "app" ? { app: step.app } : {}), ...(step.kind === "decide" ? { cases: step.cases } : {}), ...(on ? { on } : {}) }; }),
  args: Object.keys(workflow.args),
});

const GLOBAL = { everyChat: true } as const;
const SAVERS_FILE = "skill-burger-savers.json";

/** Who saved each burger (a person's key), so only they or an admin rename or remove it. One moved from a bot has none. */
function savers(root: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, SAVERS_FILE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}
function setSaver(root: string, name: string, saver: string | null | undefined, from?: string): void {
  const all = savers(root);
  if (from !== undefined) delete all[from];
  if (saver) all[name] = saver;
  else delete all[name];
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, SAVERS_FILE), `${JSON.stringify(all, null, 2)}\n`);
}
export const saverOf = (name: string, root: string = skillsLibraryRoot()): string | undefined => savers(root)[name];

/** Every saved burger whose files are as saved; newest first. They are all used in every chat, by every bot. */
export function listWorkflowSkills(root: string = skillsLibraryRoot()): SavedWorkflow[] {
  const index = readSkillLibraryIndex(root);
  return listLibrarySkills(root)
    .filter((skill) => skill.enabled && skill.tags?.includes(WORKFLOW_TAG))
    .flatMap((skill) => {
      const found = readAt(GLOBAL, skill.name, root);
      return found ? [listed(skill.name, found.workflow, found.sha256, index[skill.name]!.importedAt, found.botId)] : [];
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function readWorkflowSkill(name: string, root: string = skillsLibraryRoot()): { text: string; workflow: Workflow } | null {
  const found = readAt(GLOBAL, name, root);
  if (!found) return null;
  try {
    return { text: readFileSync(librarySkillFilePath(name, root), "utf8"), workflow: found.workflow };
  } catch {
    return null;
  }
}

function taken(botIds: readonly string[], root: string): Set<string> {
  return new Set([...Object.keys(readSkillLibraryIndex(root)), ...botIds.flatMap((botId) => Object.keys(readManifest(botId)))]);
}

/** Writes a checked workflow under `name` for every chat; the caller has made sure the name is free. `origin`: the bot
 * it was made with. */
function write(name: string, workflow: Workflow, origin: string | undefined, root: string): SavedWorkflow | Failure {
  const body = `${JSON.stringify(workflow, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > WORKFLOW_MAX_BYTES) return { error: "This run is too large to save as a skill." };
  const installed = installLibrarySkill({
    name, instructions: renderWorkflowSkillMd(name, workflow), source: origin ? burgerSource(origin) : "skill-burger", tags: [WORKFLOW_TAG],
    reviewState: "approved", files: [{ path: WORKFLOW_FILE, content: body }], root,
  });
  if ("error" in installed) return { error: installed.error };
  const everyBot = setLibrarySkillEveryBot(name, true, root);
  if ("error" in everyBot) return { error: everyBot.error };
  return listWorkflowSkills(root).find((skill) => skill.name === name) ?? { error: "The skill was saved but can't be read back." };
}

/** Takes away the copy with this hash. */
function erase(name: string, sha256: string, root: string): { removed: true } | { stale: true } | { error: string } {
  const found = readAt(GLOBAL, name, root);
  if (!found || found.sha256 !== sha256) return { stale: true };
  const result = retireLibrarySkill(name, found.instructionSha256, root);
  return "retired" in result ? { removed: true } : result;
}

/** Saves a run for every chat and every bot. `name` is the person's own, or one made from the summary, free across the
 * library and every bot's own skills; the same run saved again from the same bot is the copy already there. */
export function saveWorkflowSkill(input: { workflow: unknown; botIds: readonly string[]; name?: string; origin?: string; savedBy?: string | null; root?: string }): SavedWorkflow | Failure {
  const root = input.root ?? skillsLibraryRoot();
  const checked = workflowSchema.safeParse(input.workflow);
  if (!checked.success) return { error: "This run can't be saved as a skill." };
  const asked = input.name?.trim();
  const same = JSON.stringify(checked.data);
  if (!asked) {
    const already = listWorkflowSkills(root).find((skill) => skill.botId === input.origin && JSON.stringify(readAt(GLOBAL, skill.name, root)?.workflow) === same);
    if (already) return already;
  }
  const names = taken(input.botIds, root);
  if (asked) {
    if (!isSkillName(asked)) return { error: "Use lowercase letters, numbers and hyphens for the name." };
    if (names.has(asked)) return { error: "That name is taken. Try another.", taken: true };
  }
  const saved = write(asked || workflowSkillName(checked.data.summary, names), checked.data, input.origin, root);
  if (!("error" in saved)) setSaver(root, saved.name, input.savedBy);
  return saved;
}

/** Undo or remove: takes away the copy with this hash, so it never removes one someone changed since. */
export function removeWorkflowSkill(name: string, sha256: string | undefined, root: string = skillsLibraryRoot()) {
  const found = readAt(GLOBAL, name, root);
  if (!found) return { stale: true } as const;
  const gone = erase(name, sha256 ?? found.sha256, root);
  if ("removed" in gone) setSaver(root, name, null);
  return gone;
}

/** The burger a bot runs by this name: the one every chat uses, else (not moved yet) one of the bot's own. */
export function findWorkflowSkill(botId: string, name: string, root: string = skillsLibraryRoot()): { workflow: Workflow; sha256: string } | null {
  const found = readAt(GLOBAL, name, root) ?? readAt({ botId }, name, root);
  return found ? { workflow: found.workflow, sha256: found.sha256 } : null;
}

/** Puts a changed workflow in place of the copy with `sha256`, under the same name; the old copy comes back if the new
 * one can't be written. */
export function replaceWorkflowSkill(input: { name: string; workflow: unknown; sha256: string; root?: string }): SavedWorkflow | Failure | { stale: true } {
  const root = input.root ?? skillsLibraryRoot();
  const checked = workflowSchema.safeParse(input.workflow);
  if (!checked.success) return { error: checked.error.issues.map((issue) => issue.message).join("; ").slice(0, 300) };
  const found = readAt(GLOBAL, input.name, root);
  if (!found || found.sha256 !== input.sha256) return { stale: true };
  const gone = erase(input.name, found.sha256, root);
  if (!("removed" in gone)) return "error" in gone ? gone : { stale: true };
  const written = write(input.name, checked.data, found.botId, root);
  if ("error" in written) write(input.name, found.workflow, found.botId, root);
  return written;
}

/** Rename: the same burger under a new name, with its SKILL.md written for that name. */
export function renameWorkflowSkill(input: { name: string; to: string; botIds: readonly string[]; sha256?: string; root?: string }): SavedWorkflow | Failure | { stale: true } {
  const root = input.root ?? skillsLibraryRoot();
  const found = readAt(GLOBAL, input.name, root);
  if (!found || (input.sha256 && found.sha256 !== input.sha256)) return { stale: true };
  if (!isSkillName(input.to)) return { error: "Use lowercase letters, numbers and hyphens for the name." };
  if (taken(input.botIds, root).has(input.to)) return { error: "That name is taken. Try another.", taken: true };
  const renamed = write(input.to, found.workflow, found.botId, root);
  if ("error" in renamed) return renamed;
  const gone = erase(input.name, found.sha256, root);
  if (!("removed" in gone)) {
    erase(input.to, renamed.sha256, root);
    return "error" in gone ? gone : { stale: true };
  }
  setSaver(root, input.to, saverOf(input.name, root), input.name);
  return renamed;
}

/** Moves every bot's own burgers (saved before burgers were for every chat) into every chat, once. A name already used
 * there keeps both, the moved one with a number after it; nothing is overwritten. Safe to run again: a bot's copy whose
 * workflow is already there from that bot is only taken away. */
export function migrateBotBurgers(botIds: readonly string[], root: string = skillsLibraryRoot()): Array<{ botId: string; from: string; to: string }> {
  const moved: Array<{ botId: string; from: string; to: string }> = [];
  for (const botId of botIds) {
    for (const skill of listSkills(botId).filter((one) => isBurgerSource(one.source))) {
      const found = readAt({ botId }, skill.name, root);
      if (!found) continue;
      const same = JSON.stringify(found.workflow);
      const there = listWorkflowSkills(root).find((one) => one.botId === botId && (one.name === skill.name || one.name.startsWith(`${skill.name}-`)) && JSON.stringify(readAt(GLOBAL, one.name, root)?.workflow) === same);
      let to = there?.name;
      if (!to) {
        const names = taken([], root);
        to = skill.name;
        for (let n = 2; names.has(to); n += 1) to = `${skill.name}-${n}`;
        const written = write(to, found.workflow, botId, root);
        if ("error" in written) continue;
      }
      const gone = removeSkill(botId, skill.name);
      if ("removed" in gone) moved.push({ botId, from: skill.name, to });
    }
  }
  return moved;
}

/** The turn's list of burgers used in every chat, for a bot that doesn't already see them through the skills library.
 * A bot's own burgers are its own skills and listed with them. */
/** `taken`: names the bot's own skills already hold (one on all of the person's bots among them): theirs is the one line. */
export function workflowSkillsPrompt(botId: string, root: string = skillsLibraryRoot(), taken: ReadonlySet<string> = new Set()): string {
  const optedOut = new Set([...librarySkillOptOuts(botId), ...taken]);
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
    ? `\n\nSaved workflows (runs the person saved as skills for every chat; when one fits the task, run it with the run_workflow tool; read its SKILL.md for what it does):\n${lines.join("\n")}`
    : "";
}
