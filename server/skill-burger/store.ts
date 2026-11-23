// Saved burgers are ordinary skill folders (SKILL.md + workflow.json). One belongs to the bot it was made with, as that
// bot's own skill, until someone turns on "Use in every chat": then it moves into the shared skills library, tagged
// "workflow" and on for every bot, and turning it off moves it back. Library ones are listed to every bot whether or not
// the library is switched on. Undo, rename and remove act on the exact copy they saw and refuse one that changed since.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { burgerBotOf, burgerSource, isBurgerSource, type SavedWorkflow } from "../../shared/skill-burger/saved.ts";
import { isSkillName } from "../../shared/skill-md.ts";
import { caseOf, WORKFLOW_FILE, WORKFLOW_MAX_BYTES, WORKFLOW_TAG, renderWorkflowSkillMd, workflowSchema, workflowSkillName, type Workflow } from "../../shared/skill-burger/format.ts";
import {
  installLibrarySkill, librarySkillDirectory, librarySkillFilePath, librarySkillOptOuts, listLibrarySkills, readSkillLibraryIndex,
  retireLibrarySkill, setLibrarySkillEveryBot, skillsLibraryRoot,
} from "../skill-library.ts";
import { installSkill, listSkills, readManifest, removeSkill, setSkillEnabled, skillDirectory } from "../skills.ts";

export type { SavedWorkflow };

const PROMPT_MAX_SKILLS = 20;
const PROMPT_MAX_BYTES = 2_000;

/** Where a saved burger is: one bot's own skills, or the shared library. */
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

function readAt(place: BurgerPlace, name: string, root: string): { workflow: Workflow; sha256: string; botId?: string } | null {
  if (!isSkillName(name)) return null;
  if ("everyChat" in place) {
    const entry = readSkillLibraryIndex(root)[name];
    if (!entry?.tags?.includes(WORKFLOW_TAG)) return null;
    const workflow = parsed(join(librarySkillDirectory(root, name), WORKFLOW_FILE));
    return workflow ? { workflow, sha256: entry.sha256, botId: burgerBotOf(entry.source) } : null;
  }
  const folder = botFolder(place.botId, name);
  const workflow = parsed(folder && join(folder, WORKFLOW_FILE));
  const entry = readManifest(place.botId)[name];
  return workflow && entry ? { workflow, sha256: entry.sha256, botId: place.botId } : null;
}

const listed = (name: string, workflow: Workflow, sha256: string, savedAt: string, everyChat: boolean, botId: string | undefined): SavedWorkflow => ({
  name, summary: workflow.summary, sha256, savedAt, everyChat, ...(botId ? { botId } : {}),
  layers: workflow.steps.map((step) => { const on = caseOf(step); return { id: step.id, kind: step.kind, label: step.label, ...(step.kind === "app" ? { app: step.app } : {}), ...(step.kind === "decide" ? { cases: step.cases } : {}), ...(on ? { on } : {}) }; }),
  args: Object.keys(workflow.args),
});

/** Every saved burger whose files are as saved: the library's, then each of `botIds`' own; newest first. */
export function listWorkflowSkills(botIds: readonly string[], root: string = skillsLibraryRoot()): SavedWorkflow[] {
  const index = readSkillLibraryIndex(root);
  const shared = listLibrarySkills(root)
    .filter((skill) => skill.enabled && skill.tags?.includes(WORKFLOW_TAG))
    .flatMap((skill) => {
      const found = readAt({ everyChat: true }, skill.name, root);
      return found ? [listed(skill.name, found.workflow, found.sha256, index[skill.name]!.importedAt, true, found.botId)] : [];
    });
  const own = botIds.flatMap((botId) => listSkills(botId)
    .filter((skill) => skill.enabled && isBurgerSource(skill.source))
    .flatMap((skill) => {
      const found = readAt({ botId }, skill.name, root);
      return found ? [listed(skill.name, found.workflow, found.sha256, skill.importedAt, false, botId)] : [];
    }));
  return [...shared, ...own].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function readWorkflowSkill(place: BurgerPlace, name: string, root: string = skillsLibraryRoot()): { text: string; workflow: Workflow } | null {
  const found = readAt(place, name, root);
  if (!found) return null;
  try {
    const file = "everyChat" in place ? librarySkillFilePath(name, root) : join(botFolder(place.botId, name)!, "SKILL.md");
    return { text: readFileSync(file, "utf8"), workflow: found.workflow };
  } catch {
    return null;
  }
}

function taken(botIds: readonly string[], root: string): Set<string> {
  return new Set([...Object.keys(readSkillLibraryIndex(root)), ...botIds.flatMap((botId) => Object.keys(readManifest(botId)))]);
}

/** Writes a checked workflow to `place` under `name`; the caller has made sure the name is free there. */
function write(place: BurgerPlace, name: string, workflow: Workflow, origin: string | undefined, root: string): SavedWorkflow | Failure {
  const body = `${JSON.stringify(workflow, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > WORKFLOW_MAX_BYTES) return { error: "This run is too large to save as a skill." };
  const files = [{ path: "SKILL.md", content: renderWorkflowSkillMd(name, workflow) }, { path: WORKFLOW_FILE, content: body }];
  const botId = "botId" in place ? place.botId : origin;
  const source = botId ? burgerSource(botId) : "skill-burger";
  if ("everyChat" in place) {
    const installed = installLibrarySkill({ name, instructions: files[0]!.content, source, tags: [WORKFLOW_TAG], reviewState: "approved", files: [files[1]!], root });
    if ("error" in installed) return { error: installed.error };
    const everyBot = setLibrarySkillEveryBot(name, true, root);
    if ("error" in everyBot) return { error: everyBot.error };
  } else {
    const installed = installSkill(place.botId, source, files);
    if ("error" in installed) return { error: installed.error };
    const enabled = setSkillEnabled(place.botId, name, true);
    if ("error" in enabled) return { error: enabled.error };
  }
  const stored = listWorkflowSkills("botId" in place ? [place.botId] : [], root).find((skill) => skill.name === name && skill.everyChat === ("everyChat" in place));
  return stored ?? { error: "The skill was saved but can't be read back." };
}

/** Takes away the copy at `place` with this hash. */
function erase(place: BurgerPlace, name: string, sha256: string, root: string): { removed: true } | { stale: true } | { error: string } {
  const found = readAt(place, name, root);
  if (!found || found.sha256 !== sha256) return { stale: true };
  if ("everyChat" in place) {
    const result = retireLibrarySkill(name, sha256, root);
    return "retired" in result ? { removed: true } : result;
  }
  const result = removeSkill(place.botId, name);
  return "removed" in result ? { removed: true } : result;
}

/** Saves a run to `place` (the bot that made it, unless it is put back where it was). `name` is the person's own, or one
 * made from the summary; it is free across the library and `botIds`, so turning it on for every chat never collides. */
export function saveWorkflowSkill(input: { workflow: unknown; place: BurgerPlace; botIds: readonly string[]; name?: string; origin?: string; root?: string }): SavedWorkflow | Failure {
  const root = input.root ?? skillsLibraryRoot();
  const checked = workflowSchema.safeParse(input.workflow);
  if (!checked.success) return { error: "This run can't be saved as a skill." };
  const asked = input.name?.trim();
  const origin = "botId" in input.place ? input.place.botId : input.origin;
  const same = JSON.stringify(checked.data);
  if (!asked) {
    const already = listWorkflowSkills(input.botIds, root).find((skill) => skill.botId === origin && JSON.stringify(readAt(skill.everyChat ? { everyChat: true } : { botId: skill.botId! }, skill.name, root)?.workflow) === same);
    if (already) return already;
  }
  const names = taken(input.botIds, root);
  if (asked) {
    if (!isSkillName(asked)) return { error: "Use lowercase letters, numbers and hyphens for the name." };
    if (names.has(asked)) return { error: "That name is taken. Try another.", taken: true };
  }
  return write(input.place, asked || workflowSkillName(checked.data.summary, names), checked.data, input.origin, root);
}

/** Undo or remove: takes away the copy with this hash, so it never removes one someone changed since. */
export function removeWorkflowSkill(place: BurgerPlace, name: string, sha256: string | undefined, root: string = skillsLibraryRoot()) {
  const found = readAt(place, name, root);
  if (!found) return { stale: true } as const;
  return erase(place, name, sha256 ?? found.sha256, root);
}

/** "Use in every chat": on moves a bot's burger into the shared library, off moves it back to the bot it came from. */
export function setWorkflowEveryChat(input: { name: string; everyChat: boolean; botId?: string; sha256?: string; root?: string }): SavedWorkflow | Failure | { stale: true } {
  const root = input.root ?? skillsLibraryRoot();
  const from: BurgerPlace = input.everyChat ? { botId: input.botId ?? "" } : { everyChat: true };
  const found = readAt(from, input.name, root);
  if (!found || (input.sha256 && found.sha256 !== input.sha256)) return { stale: true };
  const to: BurgerPlace = input.everyChat ? { everyChat: true } : { botId: found.botId ?? "" };
  if ("botId" in to && !to.botId) return { error: "The bot this Skill Burger came from is gone." };
  if ("everyChat" in to ? readSkillLibraryIndex(root)[input.name] : readManifest(to.botId)[input.name]) return { error: "That name is taken. Try another.", taken: true };
  const moved = write(to, input.name, found.workflow, found.botId, root);
  if ("error" in moved) return moved;
  const gone = erase(from, input.name, found.sha256, root);
  if (!("removed" in gone)) {
    erase(to, input.name, moved.sha256, root);
    return "error" in gone ? gone : { stale: true };
  }
  return moved;
}

/** The burger a bot runs by this name: its own first, then one used in every chat. */
export function findWorkflowSkill(botId: string, name: string, root: string = skillsLibraryRoot()): { place: BurgerPlace; workflow: Workflow; sha256: string } | null {
  for (const place of [{ botId }, { everyChat: true as const }] satisfies BurgerPlace[]) {
    const found = readAt(place, name, root);
    if (found) return { place, workflow: found.workflow, sha256: found.sha256 };
  }
  return null;
}

/** Puts a changed workflow in place of the copy with `sha256`, under the same name; the old copy comes back if the new
 * one can't be written. */
export function replaceWorkflowSkill(input: { place: BurgerPlace; name: string; workflow: unknown; sha256: string; root?: string }): SavedWorkflow | Failure | { stale: true } {
  const root = input.root ?? skillsLibraryRoot();
  const checked = workflowSchema.safeParse(input.workflow);
  if (!checked.success) return { error: checked.error.issues.map((issue) => issue.message).join("; ").slice(0, 300) };
  const found = readAt(input.place, input.name, root);
  if (!found || found.sha256 !== input.sha256) return { stale: true };
  const gone = erase(input.place, input.name, found.sha256, root);
  if (!("removed" in gone)) return "error" in gone ? gone : { stale: true };
  const written = write(input.place, input.name, checked.data, found.botId, root);
  if ("error" in written) write(input.place, input.name, found.workflow, found.botId, root);
  return written;
}

/** Rename: the same burger under a new name in the same place, with its SKILL.md written for that name. */
export function renameWorkflowSkill(input: { place: BurgerPlace; name: string; to: string; botIds: readonly string[]; sha256?: string; root?: string }): SavedWorkflow | Failure | { stale: true } {
  const root = input.root ?? skillsLibraryRoot();
  const found = readAt(input.place, input.name, root);
  if (!found || (input.sha256 && found.sha256 !== input.sha256)) return { stale: true };
  if (!isSkillName(input.to)) return { error: "Use lowercase letters, numbers and hyphens for the name." };
  if (taken(input.botIds, root).has(input.to)) return { error: "That name is taken. Try another.", taken: true };
  const renamed = write(input.place, input.to, found.workflow, found.botId, root);
  if ("error" in renamed) return renamed;
  const gone = erase(input.place, input.name, found.sha256, root);
  if (!("removed" in gone)) {
    erase(input.place, input.to, renamed.sha256, root);
    return "error" in gone ? gone : { stale: true };
  }
  return renamed;
}

/** The turn's list of burgers used in every chat, for a bot that doesn't already see them through the skills library.
 * A bot's own burgers are its own skills and listed with them. */
export function workflowSkillsPrompt(botId: string, root: string = skillsLibraryRoot()): string {
  const optedOut = librarySkillOptOuts(botId);
  const lines: string[] = [];
  let bytes = 0;
  for (const saved of listWorkflowSkills([], root)) {
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
