import type { GroupDefaultResponder } from "./store.ts";

// Odd by design: coordinator/worker alternation must always leave the final
// bounded turn to the coordinator for an honest completion decision.
export const GROUP_GOAL_MAX_TURNS = 13;
export const GROUP_GOAL_CONTROL_OPEN = "<openmaus-goal>";
export const GROUP_GOAL_CONTROL_CLOSE = "</openmaus-goal>";

export type GroupGoalDecision =
  | { status: "continue"; next: string; instruction: string; detail?: string }
  | { status: "completed" | "needs-input" | "blocked"; detail: string };

export interface GoalRunMember {
  id: string;
  name: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
}

export interface ParsedGroupGoalDecision {
  visibleText: string;
  decision: GroupGoalDecision | null;
}

const bounded = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

function visibleCoordinatorText(text: string): string {
  let visible = text;
  for (;;) {
    const closeAt = visible.indexOf(GROUP_GOAL_CONTROL_CLOSE);
    if (closeAt < 0) break;
    const openAt = visible.lastIndexOf(GROUP_GOAL_CONTROL_OPEN, closeAt);
    if (openAt < 0) {
      visible = `${visible.slice(0, closeAt)}${visible.slice(closeAt + GROUP_GOAL_CONTROL_CLOSE.length)}`;
      continue;
    }
    visible = `${visible.slice(0, openAt)}${visible.slice(closeAt + GROUP_GOAL_CONTROL_CLOSE.length)}`;
  }
  // A truncated final envelope is private protocol too. Keep the prose that
  // preceded it, but never expose a half-written marker or JSON fragment.
  const danglingOpen = visible.indexOf(GROUP_GOAL_CONTROL_OPEN);
  if (danglingOpen >= 0) visible = visible.slice(0, danglingOpen);
  return visible.replaceAll(GROUP_GOAL_CONTROL_CLOSE, "").trim();
}

/** Keep the orchestration envelope out of the human transcript while still
 * accepting ordinary prose before it. The last complete envelope wins: a
 * quoted example earlier in the reply cannot accidentally steer the run. */
export function parseGroupGoalDecision(text: string): ParsedGroupGoalDecision {
  const closeAt = text.lastIndexOf(GROUP_GOAL_CONTROL_CLOSE);
  const openAt = closeAt < 0 ? -1 : text.lastIndexOf(GROUP_GOAL_CONTROL_OPEN, closeAt);
  if (openAt < 0 || closeAt < 0) return { visibleText: visibleCoordinatorText(text), decision: null };

  const visibleText = visibleCoordinatorText(text);
  const payload = text.slice(openAt + GROUP_GOAL_CONTROL_OPEN.length, closeAt).trim();
  try {
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const status = raw.status;
    const detail = bounded(raw.detail, 500);
    if (status === "continue") {
      const next = bounded(raw.next, 100);
      const instruction = bounded(raw.instruction, 2_000);
      if (!next || !instruction) return { visibleText, decision: null };
      return {
        visibleText,
        decision: { status, next, instruction, ...(detail ? { detail } : {}) },
      };
    }
    if (status === "completed" || status === "needs-input" || status === "blocked") {
      if (!detail) return { visibleText, decision: null };
      return { visibleText, decision: { status, detail } };
    }
  } catch {
    // A malformed control envelope is a safe pause, never permission to keep
    // an autonomous loop running on a guess.
  }
  return { visibleText, decision: null };
}

/** Explicit room lead wins. Otherwise prefer an in-room Chief, then the
 * first active member. A goal run never recruits somebody outside the room. */
export function selectGroupGoalCoordinator<Member extends GoalRunMember>(
  members: Member[],
  responder: GroupDefaultResponder,
): Member | null {
  const active = members.filter((member) => !member.hidden);
  if (responder.kind === "member") {
    const explicit = active.find((member) => member.id === responder.botId);
    if (explicit) return explicit;
  }
  return active.find((member) => member.chiefOfStaff) ?? active[0] ?? null;
}

/** Resolve a model-selected teammate without letting fuzzy or duplicate
 * names choose the wrong person. IDs always work; names work only if unique. */
export function resolveGroupGoalMember(reference: string, members: GoalRunMember[]): GoalRunMember | null {
  const wanted = reference.trim().replace(/^@/, "").toLocaleLowerCase();
  if (!wanted) return null;
  const active = members.filter((member) => !member.hidden);
  const idMatch = active.find((member) => member.id.toLocaleLowerCase() === wanted);
  if (idMatch) return idMatch;
  const nameMatches = active.filter((member) => member.name.toLocaleLowerCase() === wanted);
  return nameMatches.length === 1 ? nameMatches[0]! : null;
}

export function groupGoalCoordinatorInstructions(args: {
  goal: string;
  members: GoalRunMember[];
  turn: number;
  maxTurns: number;
  remainingTurns: number;
}): string {
  const roster = args.members
    .filter((member) => !member.hidden)
    .map((member) => `${member.name} (${member.id})`)
    .join(", ");
  return [
    "You are the lead coordinator for a bounded team goal run.",
    `Goal: ${args.goal}`,
    `Available room members: ${roster}.`,
    `This is team turn ${args.turn} of ${args.maxTurns}; ${args.remainingTurns} turn(s) remain after this one.`,
    "Use the conversation as the progress ledger. Decide whether the goal is genuinely complete, needs the human, is blocked, or needs one named teammate next.",
    "Do not continue merely to generate discussion. Do not claim completion unless the requested deliverable or answer is present in the conversation.",
    "Write a brief human-facing update or final answer, then end with exactly one private control envelope on its own line.",
    `${GROUP_GOAL_CONTROL_OPEN}{"status":"continue","next":"Exact member id from the roster","instruction":"Concrete next assignment","detail":"Short progress note"}${GROUP_GOAL_CONTROL_CLOSE}`,
    `Or use status "completed", "needs-input", or "blocked" with a non-empty "detail" and omit next/instruction.`,
    "Never mention, quote, or explain the control envelope in your human-facing text.",
  ].join("\n");
}

export function groupGoalWorkerInstructions(args: {
  goal: string;
  coordinatorName: string;
  assignment: string;
  turn: number;
  maxTurns: number;
}): string {
  return [
    `You are a specialist contributing to a bounded team goal run led by ${args.coordinatorName}.`,
    `Goal: ${args.goal}`,
    `Your assignment: ${args.assignment}`,
    `This is team turn ${args.turn} of ${args.maxTurns}.`,
    "Do the assigned work now and put concrete results, evidence, or a clear blocker in your reply.",
    `Address your result to ${args.coordinatorName}. Do not invent a new orchestration protocol or emit an openmaus-goal control envelope.`,
  ].join("\n");
}

export function groupGoalAssignmentKey(memberId: string, instruction: string): string {
  return `${memberId}:${instruction.trim().toLocaleLowerCase().replace(/\s+/g, " ")}`;
}
