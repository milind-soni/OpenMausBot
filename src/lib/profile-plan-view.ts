import type { ProfileApplyResult, ProfileChoice, ProfilePlan, ProfilePlanLine } from "../../shared/profile-plan";

export type PlanGroupId = "problems" | "add" | "change" | "access" | "changedHere" | "conflict" | "gone" | "later" | "notes";

export interface PlanGroup {
  id: PlanGroupId;
  /** Plan lines; `problems` and some `notes` are file sentences instead. */
  lines: ProfilePlanLine[];
  sentences: string[];
}

/** A conflict the person already settled: the plan sent with that choice no longer lists it, so the page keeps it. */
export type SettledConflicts = ReadonlyMap<string, ProfilePlanLine>;

const GROUP_OF: Record<ProfilePlanLine["kind"], PlanGroupId> = {
  add: "add", change: "change", access: "access", conflict: "conflict", "changed-here": "changedHere",
  gone: "gone", remove: "gone", blocked: "problems", later: "later", note: "notes",
};
const ORDER: readonly PlanGroupId[] = ["problems", "add", "change", "access", "changedHere", "conflict", "gone", "later", "notes"];

const sameField = (a: ProfilePlanLine, b: ProfilePlanLine) => a.subject.id === b.subject.id && a.field === b.field;

/** The plan in the order the page shows it, empty groups left out. A settled conflict stays under Conflicts with its
 * choice; the plain line the server adds for it ("you keep yours", or the file's value as a change) is not repeated.
 * A settled conflict that gives more access still shows under Gives more access, which needs its own confirmation. */
export function planGroups(plan: ProfilePlan, settled: SettledConflicts = new Map()): PlanGroup[] {
  const settledLines = [...settled.values()];
  const groups = new Map<PlanGroupId, PlanGroup>(ORDER.map((id) => [id, { id, lines: [], sentences: [] }]));
  for (const line of plan.lines) {
    if ((line.kind === "note" || line.kind === "change") && settledLines.some((conflict) => sameField(conflict, line))) continue;
    groups.get(GROUP_OF[line.kind])!.lines.push(line);
  }
  const conflicts = groups.get("conflict")!;
  for (const line of settledLines) if (!conflicts.lines.some((open) => open.conflict?.choice === line.conflict?.choice)) conflicts.lines.push(line);
  groups.get("problems")!.sentences.push(...plan.problems.map((problem) => problem.sentence));
  groups.get("notes")!.sentences.push(...plan.warnings.map((warning) => warning.sentence));
  return ORDER.map((id) => groups.get(id)!).filter((group) => group.lines.length || group.sentences.length);
}

/** The folder has no profile files at all: the page explains what a profile folder is instead of listing a problem. */
export function folderIsEmpty(plan: ProfilePlan): boolean {
  return plan.problems.some((problem) => problem.file === "." && problem.message.startsWith("has no profiles"));
}

/** Conflicts still waiting for Keep mine or Take the file's. */
export function openConflicts(plan: ProfilePlan, choices: Readonly<Record<string, ProfileChoice>>): ProfilePlanLine[] {
  return plan.lines.filter((line) => line.kind === "conflict" && line.conflict && !choices[line.conflict.choice]);
}

/** Something would change: lines to apply, or a settled conflict to record. */
export function planHasWork(plan: ProfilePlan, choices: Readonly<Record<string, ProfileChoice>>): boolean {
  return !plan.noChanges && (Object.keys(choices).length > 0 || plan.lines.some((line) => ["add", "change", "access", "remove"].includes(line.kind)));
}

/** What is left needs more access and nothing else: applying without it would change nothing. */
export function onlyAccessLeft(plan: ProfilePlan, choices: Readonly<Record<string, ProfileChoice>>): boolean {
  return planHasWork(plan, choices) && Object.keys(choices).length === 0 && plan.lines.some((line) => line.kind === "access")
    && !plan.lines.some((line) => ["add", "change", "remove"].includes(line.kind));
}

/** The bots an apply changed, each counted once. */
export function botsUpdated(result: ProfileApplyResult): number {
  return new Set(result.applied.lines.filter((line) => line.subject.kind === "bot").map((line) => line.subject.id)).size;
}

/** The names of the bots that more-access lines are about, each once, in plan order. */
export function accessNames(plan: ProfilePlan): string[] {
  return [...new Set(plan.lines.filter((line) => line.kind === "access").map((line) => line.subject.name))];
}
