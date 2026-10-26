import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { GroupDefaultResponder } from "./store.ts";

// Odd so the final bounded turn always falls to the coordinator for the completion decision.
export const GROUP_GOAL_MAX_TURNS = 13;
export const GROUP_GOAL_WAIT_MAX_MS = Math.max(1_000, Number(process.env.OMB_GOAL_WAIT_MAX_MS) || 30 * 60_000);
const GROUP_GOAL_MAX_WAIT_EXHAUSTIONS = 3;
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

export function groupGoalCompletionTurnId(
  eventTurnId: string | undefined,
  boundTurnId: string | undefined,
): string | undefined {
  return eventTurnId ?? boundTurnId;
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
  // Never expose a half-written control marker or JSON fragment.
  const danglingOpen = visible.indexOf(GROUP_GOAL_CONTROL_OPEN);
  if (danglingOpen >= 0) visible = visible.slice(0, danglingOpen);
  return visible.replaceAll(GROUP_GOAL_CONTROL_CLOSE, "").trim();
}

/** The last complete envelope wins, so a quoted example earlier in the reply cannot steer the run. */
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
  }
  return { visibleText, decision: null };
}

/** A goal run never recruits somebody outside the room. */
export function selectGroupGoalCoordinator<Member extends GoalRunMember>(
  members: Member[],
  responder: GroupDefaultResponder,
): Member | null {
  const active = members.filter((member) => !member.hidden);
  const lead = responder.kind === "member" ? responder.botId : responder.kind === "auto" ? responder.fallbackBotId : undefined;
  if (lead) {
    const explicit = active.find((member) => member.id === lead);
    if (explicit) return explicit;
  }
  return active.find((member) => member.chiefOfStaff) ?? active[0] ?? null;
}

export function resolveGroupGoalMember(reference: string, members: GoalRunMember[]): GoalRunMember | null {
  const wanted = reference.trim().replace(/^@/, "").toLocaleLowerCase();
  if (!wanted) return null;
  const active = members.filter((member) => !member.hidden);
  const idMatch = active.find((member) => member.id.toLocaleLowerCase() === wanted);
  if (idMatch) return idMatch;
  const nameMatches = active.filter((member) => member.name.toLocaleLowerCase() === wanted);
  return nameMatches.length === 1 ? nameMatches[0]! : null;
}

/** `solo` is a room of one: the lead does the work in its own turns, and "continue" names itself for its next turn. */
export function groupGoalCoordinatorInstructions(args: {
  goal: string;
  members: GoalRunMember[];
  turn: number;
  maxTurns: number;
  remainingTurns: number;
  note?: string;
  solo?: boolean;
}): string {
  const active = args.members.filter((member) => !member.hidden);
  const roster = active
    .map((member) => `${member.name} (${member.id})`)
    .join(", ");
  const self = args.solo ? active[0] : undefined;
  return [
    self ? "You are working alone toward a bounded goal." : "You are the lead coordinator for a bounded team goal run.",
    `Goal: ${args.goal}`,
    ...(self ? [] : [`Available room members: ${roster}.`]),
    `This is ${self ? "" : "team "}turn ${args.turn} of ${args.maxTurns}; ${args.remainingTurns} turn(s) remain after this one.`,
    ...(args.note ? [`Harness note: ${args.note}`] : []),
    self
      ? "Use the conversation as the progress ledger. Do the next concrete piece of work now, then decide whether the goal is genuinely complete, needs the human, is blocked, or needs another turn."
      : "Use the conversation as the progress ledger. Decide whether the goal is genuinely complete, needs the human, is blocked, or needs one named teammate next.",
    "Do not continue merely to generate discussion. Do not claim completion unless the requested deliverable or answer is present in the conversation.",
    "Write a brief human-facing update or final answer, then end with exactly one private control envelope on its own line.",
    self
      ? `${GROUP_GOAL_CONTROL_OPEN}{"status":"continue","next":"${self.id}","instruction":"Your next step","detail":"Short progress note"}${GROUP_GOAL_CONTROL_CLOSE}`
      : `${GROUP_GOAL_CONTROL_OPEN}{"status":"continue","next":"Exact member id from the roster","instruction":"Concrete next assignment","detail":"Short progress note"}${GROUP_GOAL_CONTROL_CLOSE}`,
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

export type GoalStepOutcome =
  | "settled"
  | "provider_failed"
  | "dispatch_failed"
  | "spend_capped"
  | "stalled"
  | "timed_out"
  | "cancelled"
  | "busy"
  | "parked"
  | "unavailable";

export interface GoalStepResult {
  ran: boolean;
  replyText: string;
  outcome?: GoalStepOutcome;
  stopReason?: string | null;
}

export type GoalRunEnd = Exclude<GroupGoalRunStatus, "working">;

export interface GoalRunDeps<Bot extends GoalRunMember> {
  run: { goal: string; turnCount: number; maxTurns: number; finished: boolean };
  coordinator: Bot;
  members: readonly Bot[];
  solo?: boolean;
  cancelled(): boolean;
  /** The member as the store has it now. */
  current(botId: string): Bot | undefined;
  /** One member turn; a step counts against the run's turns once its member is claimed. */
  step(bot: Bot, coordinator: boolean, instructions: string): Promise<GoalStepResult>;
  finish(status: GoalRunEnd, detail: string): void;
  progress(detail: string): void;
  /** An activity row in the conversation, from the coordinator. */
  note(text: string): void;
}

// spend_capped is deliberately absent: a cap refusal is deterministic.
const TRANSIENT_STEP: ReadonlySet<GoalStepOutcome | undefined> = new Set(["provider_failed", "dispatch_failed", "stalled", "timed_out"]);

async function stepOnceRetried<Bot extends GoalRunMember>(deps: GoalRunDeps<Bot>, bot: Bot, coordinator: boolean, instructions: string): Promise<GoalStepResult> {
  const first = await deps.step(bot, coordinator, instructions);
  if (!TRANSIENT_STEP.has(first.outcome) || deps.cancelled()) return first;
  deps.progress(`${bot.name}'s turn did not settle (${first.outcome!.replace("_", " ")}) — retrying once.`);
  return deps.step(bot, coordinator, instructions);
}

/** The goal run loop, the same for a room and a one-on-one chat (a room of one). */
export async function runGoalRun<Bot extends GoalRunMember>(deps: GoalRunDeps<Bot>): Promise<void> {
  const { run, coordinator } = deps;
  const assignmentCounts = new Map<string, number>();
  const goalMembers: GoalRunMember[] = deps.members.map((member) => ({
    id: member.id,
    name: member.name,
    hidden: member.hidden,
    chiefOfStaff: member.chiefOfStaff,
  }));

  let coordinatorNote: string | undefined;
  let waitExhaustions = 0;
  while (!deps.cancelled() && run.turnCount < run.maxTurns) {
    const coordinatorTurn = run.turnCount + 1;
    const note = coordinatorNote;
    coordinatorNote = undefined;
    const coordinatorResult = await stepOnceRetried(deps, coordinator, true, groupGoalCoordinatorInstructions({
      goal: run.goal,
      members: goalMembers,
      turn: coordinatorTurn,
      maxTurns: run.maxTurns,
      remainingTurns: run.maxTurns - coordinatorTurn,
      note,
      solo: deps.solo,
    }));
    if (deps.cancelled()) return;
    if (coordinatorResult.outcome === "unavailable") {
      deps.finish("blocked", `${coordinator.name} is not available.`);
      return;
    }
    if (coordinatorResult.outcome === "spend_capped") {
      deps.finish("blocked", coordinatorResult.stopReason ?? `${coordinator.name} hit the workspace spend cap.`);
      return;
    }
    if (coordinatorResult.outcome === "busy") {
      deps.finish("blocked", `${coordinatorResult.stopReason ?? `${coordinator.name} stayed busy`} — send the goal again when they are free.`);
      return;
    }
    if (coordinatorResult.outcome === "parked") {
      deps.finish(
        "blocked",
        `${coordinatorResult.stopReason ?? `${coordinator.name} parked waiting for the computer`} — send the goal again when the computer is free.`,
      );
      return;
    }
    if (!coordinatorResult.ran || coordinatorResult.outcome !== "settled") {
      const reason = coordinatorResult.stopReason?.trim().slice(0, 120);
      deps.finish("failed", `${coordinator.name} could not complete the coordination step${reason ? ` — ${reason}` : ""}.`);
      return;
    }

    const decision = parseGroupGoalDecision(coordinatorResult.replyText).decision;
    if (!decision) {
      deps.finish("blocked", `${coordinator.name} did not provide a valid next-step decision.`);
      return;
    }
    if (decision.status !== "continue") {
      deps.finish(decision.status, decision.detail);
      return;
    }
    if (run.turnCount >= run.maxTurns) break;

    const worker = resolveGroupGoalMember(decision.next, goalMembers);
    if (!worker) {
      deps.finish("blocked", `${coordinator.name} selected a teammate who is not an active member of this channel.`);
      return;
    }
    const workerBot = deps.current(worker.id);
    if (!workerBot || workerBot.hidden) {
      deps.finish("blocked", `${worker.name} is not available.`);
      return;
    }
    const assignmentKey = groupGoalAssignmentKey(worker.id, decision.instruction);
    const repeated = (assignmentCounts.get(assignmentKey) ?? 0) + 1;
    assignmentCounts.set(assignmentKey, repeated);
    if (repeated >= 3) {
      deps.finish("blocked", `The team repeated the same assignment three times without resolving the goal.`);
      return;
    }
    if (deps.solo && workerBot.id === coordinator.id) {
      coordinatorNote = `Your next step: ${decision.instruction}`;
      continue;
    }

    const workerTurn = run.turnCount + 1;
    const workerResult = await stepOnceRetried(deps, workerBot, false, groupGoalWorkerInstructions({
      goal: run.goal,
      coordinatorName: coordinator.name,
      assignment: decision.instruction,
      turn: workerTurn,
      maxTurns: run.maxTurns,
    }));
    if (deps.cancelled()) return;
    if (workerResult.outcome === "unavailable") {
      deps.finish("blocked", `${workerBot.name} is not available.`);
      return;
    }
    if (workerResult.outcome === "spend_capped") {
      deps.finish("blocked", workerResult.stopReason ?? `${workerBot.name} hit the workspace spend cap.`);
      return;
    }
    if (workerResult.outcome === "busy" || workerResult.outcome === "parked") {
      waitExhaustions += 1;
      if (waitExhaustions >= GROUP_GOAL_MAX_WAIT_EXHAUSTIONS) {
        deps.finish("blocked", `Teammates stayed busy past the wait limit ${waitExhaustions} times — try again when the team is free.`);
        return;
      }
      const reason = workerResult.stopReason?.trim().slice(0, 120) ?? `${workerBot.name} stayed busy`;
      deps.note(`${reason} — asking ${coordinator.name} to reassign`);
      deps.progress(`${reason}. ${coordinator.name} is reassigning.`);
      coordinatorNote =
        `${reason} and could not take the assignment "${decision.instruction.slice(0, 160)}". ` +
        "Reassign it to another available member, do it yourself if you can, or report blocked.";
      continue;
    }
    if (!workerResult.ran || workerResult.outcome !== "settled" || !workerResult.replyText.trim()) {
      const reason = workerResult.stopReason?.trim().slice(0, 120);
      deps.finish("failed", `${workerBot.name} could not return a result to ${coordinator.name}${reason ? ` — ${reason}` : ""}.`);
      return;
    }
  }

  if (!deps.cancelled() && !run.finished) {
    deps.finish("limit-reached", `Paused at the ${run.maxTurns}-turn safety limit. Send the goal again to continue with a fresh bounded run.`);
  }
}
