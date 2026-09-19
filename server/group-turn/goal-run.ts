// The goal coordinator/worker ladder — extracted verbatim from
// group-turn.ts. runGroupGoalStep drives one coordinator or worker member
// turn with its retry/coordination bookkeeping; runGroupGoalOperation is
// the bounded loop the channel starter hands a goal card to. The member
// turn itself arrives through the ctx from the composition root.
import { store } from "../runtime.ts";
import {
  groupGoalAssignmentKey,
  groupGoalCoordinatorInstructions,
  groupGoalWorkerInstructions,
  parseGroupGoalDecision,
  resolveGroupGoalMember,
  type GoalRunMember,
} from "../group-goal-run.ts";
import type { BotRecord } from "../store.ts";
import type { GroupGoalCoordinatorTurn } from "../event-fold.ts";
import type { GroupTurnDeps } from "../group-turn.ts";
import type { createMemberTurn } from "./member-turn.ts";
import type { GroupMemberTurnOutcome, GroupTurnOrchestration, GroupTurnOperation } from "./types.ts";

/** Everything the goal ladder reads from its host. */
interface GoalRunCtx {
  waitForGroupMemberBot: GroupTurnDeps["operations"]["waitForGroupMemberBot"];
  finishGroupGoalRun: GroupTurnDeps["operations"]["finishGroupGoalRun"];
  updateGroupGoalRunProgress: GroupTurnDeps["operations"]["updateGroupGoalRunProgress"];
  groupProviderHandshakeStarted: GroupTurnDeps["operations"]["groupProviderHandshakeStarted"];
  groupProviderHandshakeSettled: GroupTurnDeps["operations"]["groupProviderHandshakeSettled"];
  groupGoalCoordinatorTurns: GroupTurnDeps["goalFold"]["groupGoalCoordinatorTurns"];
  addGroupGoalCoordinatorTurn: GroupTurnDeps["goalFold"]["addGroupGoalCoordinatorTurn"];
  removeGroupGoalCoordinatorTurn: GroupTurnDeps["goalFold"]["removeGroupGoalCoordinatorTurn"];
  GROUP_GOAL_COORDINATOR_GUARD_MS: GroupTurnDeps["goalFold"]["GROUP_GOAL_COORDINATOR_GUARD_MS"];
  GROUP_GOAL_WAIT_MAX_MS: GroupTurnDeps["goalFold"]["GROUP_GOAL_WAIT_MAX_MS"];
  GROUP_GOAL_MAX_WAIT_EXHAUSTIONS: GroupTurnDeps["goalFold"]["GROUP_GOAL_MAX_WAIT_EXHAUSTIONS"];
  runGroupMemberTurn: ReturnType<typeof createMemberTurn>["runGroupMemberTurn"];
}

export function createGoalRun({
  waitForGroupMemberBot, finishGroupGoalRun, updateGroupGoalRunProgress,
  groupProviderHandshakeStarted, groupProviderHandshakeSettled,
  groupGoalCoordinatorTurns, addGroupGoalCoordinatorTurn, removeGroupGoalCoordinatorTurn,
  GROUP_GOAL_COORDINATOR_GUARD_MS, GROUP_GOAL_WAIT_MAX_MS, GROUP_GOAL_MAX_WAIT_EXHAUSTIONS,
  runGroupMemberTurn,
}: GoalRunCtx) {
async function runGroupGoalStep(args: {
  groupId: string;
  threadId: string;
  bot: BotRecord;
  operation: GroupTurnOperation;
  skillAuthoringClaim: { claimed: boolean };
  coordinator: boolean;
  instructions: string;
}): Promise<{ ran: boolean; replyText: string; outcome?: GroupMemberTurnOutcome; stopReason?: string | null }> {
  const run = args.operation.goalRun;
  if (!run || args.operation.cancelled || run.turnCount >= run.maxTurns) {
    return { ran: false, replyText: "" };
  }
  let retriedTransient = false;
  for (;;) {
    const availability = await waitForGroupMemberBot(args.bot, args.operation, (detail) => {
      updateGroupGoalRunProgress(args.operation, `${detail} This goal will continue when they are available.`);
    });
    if (availability === "cancelled") return { ran: false, replyText: "", outcome: "cancelled" };
    if (availability === "unavailable") {
      return { ran: false, replyText: "", outcome: "unavailable", stopReason: `${args.bot.name} is no longer available` };
    }
    if (availability === "timed_out") {
      // still busy after the cap: surface it as a busy outcome the loop can
      // route around, never as a provider failure
      const minutes = Math.max(1, Math.round(GROUP_GOAL_WAIT_MAX_MS() / 60_000));
      return {
        ran: false,
        replyText: "",
        outcome: "busy",
        stopReason: `${args.bot.name} stayed busy in another conversation for ${minutes} minute${minutes === 1 ? "" : "s"}`,
      };
    }
    if (run.turnCount >= run.maxTurns) return { ran: false, replyText: "" };

    const result: GroupTurnOrchestration["result"] = {};
    let claimed = false;
    const coordinatorTurn: GroupGoalCoordinatorTurn | undefined = args.coordinator
      ? { token: Symbol("goal-coordinator-turn"), assistantItems: [], discard: false }
      : undefined;
    if (coordinatorTurn) addGroupGoalCoordinatorTurn(args.threadId, coordinatorTurn);
    try {
      const ran = await runGroupMemberTurn(
        args.groupId,
        args.threadId,
        args.bot.id,
        run.turnCount === 0 ? 0 : 1,
        new Set(),
        undefined,
        undefined,
        () => args.operation.cancelled,
        () => groupProviderHandshakeStarted(args.operation),
        () => groupProviderHandshakeSettled(args.operation),
        args.skillAuthoringClaim,
        {
          systemInstructions: args.instructions,
          followMentions: false,
          result,
          onClaimed: () => {
            if (claimed) return;
            claimed = true;
            run.turnCount += 1;
            args.operation.botIds.add(args.bot.id);
            updateGroupGoalRunProgress(
              args.operation,
              `${args.bot.name} is working on team turn ${run.turnCount} of ${run.maxTurns}.`,
            );
          },
          onTurnStarted: (turnId) => {
            if (coordinatorTurn && !coordinatorTurn.turnId) coordinatorTurn.turnId = turnId;
          },
        },
      );
      if (result.outcome === "busy") continue;
      // One retry for a transient provider failure: a 13-turn goal must not
      // die on a single blip at turn 11. The retry claims the bot again and
      // so costs a turn like any other model call — budget is spent, never
      // stretched, and the cap still holds.
      const outcome = result.outcome;
      // spend_capped is deliberately absent: a cap refusal is deterministic,
      // and a retry would just repeat the same spend-limit activity message.
      const transient =
        outcome === "provider_failed" ||
        outcome === "dispatch_failed" ||
        outcome === "stalled" ||
        outcome === "timed_out";
      if (transient && !retriedTransient) {
        retriedTransient = true;
        updateGroupGoalRunProgress(
          args.operation,
          `${args.bot.name}'s turn did not settle (${outcome.replace("_", " ")}) — retrying once.`,
        );
        continue;
      }
      return {
        ran,
        replyText: result.replyText ?? "",
        outcome: result.outcome,
        stopReason: result.stopReason,
      };
    } finally {
      // Membership here means this bot is part of the room operation NOW,
      // not merely the next teammate the coordinator hopes to use. In
      // particular, an idle waiter must never redirect the bot's Stop button
      // away from unrelated direct work.
      args.operation.botIds.delete(args.bot.id);
      if (coordinatorTurn && groupGoalCoordinatorTurns.get(args.threadId)?.has(coordinatorTurn)) {
        if (result.outcome === "timed_out" || result.outcome === "stalled") {
          // interruptTurn is asynchronous: the orchestration can stop before
          // the provider emits its final text/completion. Retain a discard-only
          // guard so a late private decision envelope never reaches the room.
          // Broken providers get a bounded fallback; the token check keeps an
          // old timer from deleting a newer goal turn on the same thread.
          coordinatorTurn.discard = true;
          coordinatorTurn.assistantItems = [];
          const cleanupTimer = setTimeout(() => {
            removeGroupGoalCoordinatorTurn(args.threadId, coordinatorTurn);
          }, GROUP_GOAL_COORDINATOR_GUARD_MS);
          cleanupTimer.unref?.();
          coordinatorTurn.cleanupTimer = cleanupTimer;
        } else {
          removeGroupGoalCoordinatorTurn(args.threadId, coordinatorTurn);
        }
      }
    }
  }
}

async function runGroupGoalOperation(args: {
  groupId: string;
  threadId: string;
  coordinator: BotRecord;
  members: BotRecord[];
  operation: GroupTurnOperation;
}): Promise<void> {
  const run = args.operation.goalRun;
  if (!run) return;
  const skillAuthoringClaim = { claimed: false };
  const assignmentCounts = new Map<string, number>();
  const goalMembers: GoalRunMember[] = args.members.map((member) => ({
    id: member.id,
    name: member.name,
    hidden: member.hidden,
    chiefOfStaff: member.chiefOfStaff,
  }));

  // A teammate that stayed busy past the wait cap comes back to the lead as
  // a note on its next turn, so the lead reassigns instead of the run dying.
  let coordinatorNote: string | undefined;
  let waitExhaustions = 0;
  while (!args.operation.cancelled && run.turnCount < run.maxTurns) {
    const coordinatorTurn = run.turnCount + 1;
    const note = coordinatorNote;
    coordinatorNote = undefined;
    const coordinatorResult = await runGroupGoalStep({
      ...args,
      bot: args.coordinator,
      skillAuthoringClaim,
      coordinator: true,
      instructions: groupGoalCoordinatorInstructions({
        goal: run.goal,
        members: goalMembers,
        turn: coordinatorTurn,
        maxTurns: run.maxTurns,
        remainingTurns: run.maxTurns - coordinatorTurn,
        note,
      }),
    });
    if (args.operation.cancelled) return;
    if (coordinatorResult.outcome === "unavailable") {
      finishGroupGoalRun(args.groupId, args.operation, "blocked", `${args.coordinator.name} is not available.`);
      return;
    }
    if (coordinatorResult.outcome === "spend_capped") {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        coordinatorResult.stopReason ?? `${args.coordinator.name} hit the workspace spend cap.`,
      );
      return;
    }
    if (coordinatorResult.outcome === "busy") {
      // The lead is the one member the run cannot route around. Blocked, not
      // failed: the goal text is intact and nothing about the team broke.
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `${coordinatorResult.stopReason ?? `${args.coordinator.name} stayed busy`} — send the goal again when they are free.`,
      );
      return;
    }
    if (!coordinatorResult.ran || coordinatorResult.outcome !== "settled") {
      const reason = coordinatorResult.stopReason?.trim().slice(0, 120);
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "failed",
        `${args.coordinator.name} could not complete the coordination step${reason ? ` — ${reason}` : ""}.`,
      );
      return;
    }

    const decision = parseGroupGoalDecision(coordinatorResult.replyText).decision;
    if (!decision) {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `${args.coordinator.name} did not provide a valid next-step decision.`,
      );
      return;
    }
    if (decision.status !== "continue") {
      finishGroupGoalRun(args.groupId, args.operation, decision.status, decision.detail);
      return;
    }
    if (run.turnCount >= run.maxTurns) break;

    const worker = resolveGroupGoalMember(decision.next, goalMembers);
    if (!worker) {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `${args.coordinator.name} selected a teammate who is not an active member of this channel.`,
      );
      return;
    }
    const workerBot = store.bot(worker.id);
    if (!workerBot || workerBot.hidden) {
      finishGroupGoalRun(args.groupId, args.operation, "blocked", `${worker.name} is not available.`);
      return;
    }
    const assignmentKey = groupGoalAssignmentKey(worker.id, decision.instruction);
    const repeated = (assignmentCounts.get(assignmentKey) ?? 0) + 1;
    assignmentCounts.set(assignmentKey, repeated);
    if (repeated >= 3) {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        `The team repeated the same assignment three times without resolving the goal.`,
      );
      return;
    }

    const workerTurn = run.turnCount + 1;
    const workerResult = await runGroupGoalStep({
      ...args,
      bot: workerBot,
      skillAuthoringClaim,
      coordinator: false,
      instructions: groupGoalWorkerInstructions({
        goal: run.goal,
        coordinatorName: args.coordinator.name,
        assignment: decision.instruction,
        turn: workerTurn,
        maxTurns: run.maxTurns,
      }),
    });
    if (args.operation.cancelled) return;
    if (workerResult.outcome === "unavailable") {
      finishGroupGoalRun(args.groupId, args.operation, "blocked", `${workerBot.name} is not available.`);
      return;
    }
    if (workerResult.outcome === "spend_capped") {
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "blocked",
        workerResult.stopReason ?? `${workerBot.name} hit the workspace spend cap.`,
      );
      return;
    }
    if (workerResult.outcome === "busy") {
      // bounded: a team that keeps landing on busy teammates is blocked, not
      // looping — three exhausted waits per run, then stop and say so
      waitExhaustions += 1;
      if (waitExhaustions >= GROUP_GOAL_MAX_WAIT_EXHAUSTIONS()) {
        finishGroupGoalRun(
          args.groupId,
          args.operation,
          "blocked",
          `Teammates stayed busy past the wait limit ${waitExhaustions} times — try again when the team is free.`,
        );
        return;
      }
      // Soft failure, returned to the lead as data (the way a delegation
      // error reaches a manager): the goal keeps going with the remaining
      // team instead of ending on one teammate's calendar.
      const reason = workerResult.stopReason?.trim().slice(0, 120) ?? `${workerBot.name} stayed busy`;
      store.appendMessage(args.threadId, {
        role: "bot",
        kind: "activity",
        from: { botId: args.coordinator.id, name: args.coordinator.name, color: args.coordinator.color },
        tool: { name: `${reason} — asking ${args.coordinator.name} to reassign`, ok: false },
      });
      updateGroupGoalRunProgress(args.operation, `${reason}. ${args.coordinator.name} is reassigning.`);
      coordinatorNote =
        `${reason} and could not take the assignment "${decision.instruction.slice(0, 160)}". ` +
        "Reassign it to another available member, do it yourself if you can, or report blocked.";
      continue;
    }
    if (!workerResult.ran || workerResult.outcome !== "settled" || !workerResult.replyText.trim()) {
      const reason = workerResult.stopReason?.trim().slice(0, 120);
      finishGroupGoalRun(
        args.groupId,
        args.operation,
        "failed",
        `${workerBot.name} could not return a result to ${args.coordinator.name}${reason ? ` — ${reason}` : ""}.`,
      );
      return;
    }
  }

  if (!args.operation.cancelled && !run.finished) {
    finishGroupGoalRun(
      args.groupId,
      args.operation,
      "limit-reached",
      `Paused at the ${run.maxTurns}-turn safety limit. Send the goal again to continue with a fresh bounded run.`,
    );
  }
}
  return { runGroupGoalStep, runGroupGoalOperation };
}
