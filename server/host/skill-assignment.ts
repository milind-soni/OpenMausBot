import { createHash } from "node:crypto";

import type { SkillAssignmentAction } from "../../shared/skill-assignment.ts";

export interface AssignmentBot {
  id: string;
  assignedSkills?: readonly string[];
}

export interface AssignmentSkill {
  name: string;
  enabled: boolean;
  everyBot: boolean;
  sha256: string;
  filesSha256?: string;
}

export interface AssignmentDeps {
  resolveTarget(fromId: string, targetId: string): AssignmentBot | null;
  bot(id: string): AssignmentBot | null;
  listLibrary(): readonly AssignmentSkill[];
  ownNames(id: string): ReadonlySet<string>;
  optedOut(id: string): ReadonlySet<string>;
  save(id: string, names: string[]): AssignmentBot | null;
  validAssignments(names: readonly string[]): boolean;
}

function libraryIndex(deps: AssignmentDeps) {
  return new Map(deps.listLibrary().map((skill) => [skill.name, skill]));
}

function assignmentSnapshot(deps: AssignmentDeps, bot: AssignmentBot, library: ReadonlyMap<string, AssignmentSkill>) {
  const owned = deps.ownNames(bot.id);
  const optedOut = deps.optedOut(bot.id);
  const assigned = new Set(bot.assignedSkills);
  return {
    names: new Set([...library.keys(), ...assigned]),
    skill(name: string) {
      const entry = library.get(name);
      const explicit = assigned.has(name);
      const shadowed = owned.has(name);
      const inherited = entry?.everyBot === true && !optedOut.has(name);
      const enabled = entry?.enabled ?? false;
      const state = {
        name,
        in_library: Boolean(entry),
        scope: entry ? (entry.everyBot ? "all_bots" : "selected_bots") : null,
        assigned: explicit,
        shadowed,
        enabled,
        available: enabled && !shadowed && (explicit || inherited),
        content_revision: entry?.sha256 ?? null,
        package_files_revision: entry?.filesSha256 ?? null,
      };
      const management_revision = createHash("sha256").update(JSON.stringify([bot.id, state, inherited])).digest("hex");
      return { ...state, management_revision };
    },
  };
}

export function listSkillAssignments(deps: AssignmentDeps, fromId: string, targetId: string, query = "") {
  const target = deps.resolveTarget(fromId, targetId);
  const from = deps.bot(fromId);
  if (!target || !from) return null;
  const library = libraryIndex(deps);
  const source = assignmentSnapshot(deps, from, library);
  const view = assignmentSnapshot(deps, target, library);
  const matching = query.toLowerCase();
  return {
    target_bot_id: target.id,
    library: [...view.names].filter((name) => {
      const row = view.skill(name);
      return name.includes(matching) && (row.assigned || source.skill(name).available);
    }).sort().map(view.skill),
  };
}

export function changeSkillAssignment(deps: AssignmentDeps, fromId: string, targetId: string, action: SkillAssignmentAction, name: string, revision: string) {
  const target = deps.resolveTarget(fromId, targetId);
  const from = deps.bot(fromId);
  if (!target || !from) return { status: 403, error: "Only a current Chief can manage a visible target in their authorized scope." };
  const library = libraryIndex(deps);
  const before = assignmentSnapshot(deps, target, library).skill(name);
  const source = assignmentSnapshot(deps, from, library).skill(name);
  if (!(before.assigned || source.available)) return { status: 422, error: "List the target's assignments first. This skill isn't visible for management." };
  if (before.management_revision !== revision) return { status: 409, error: "The skill or assignment changed. Call skills_list with target_bot_id again." };
  const adding = action !== "unassign";
  if (adding && (!source.available || !before.enabled || before.shadowed)) {
    return { status: 422, error: "The Chief must have the enabled library skill, and the target must not have a private skill with the same name." };
  }
  const previous = target.assignedSkills ?? [];
  const names = adding ? (before.assigned ? previous : [...previous, name]) : previous.filter((skill) => skill !== name);
  if (adding && !before.assigned && !deps.validAssignments(names)) return { status: 422, error: "The target can have at most 200 explicit skill assignments." };
  let saved = target;
  if (names.length !== previous.length) {
    try {
      const current = deps.save(target.id, [...names]);
      if (!current) return { status: 409, error: "The target is no longer available; list again before retrying." };
      saved = current;
    } catch {
      return { status: 500, error: "The assignment could not be saved. List the target before retrying." };
    }
  }
  const skill = assignmentSnapshot(deps, saved, library).skill(name);
  if (skill.assigned !== adding) return { status: 500, error: "The assignment could not be verified. List the target before retrying." };
  return { status: 200, result: { target_bot_id: saved.id, skill } };
}
