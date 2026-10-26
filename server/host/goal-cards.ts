// The goal run card: one receipt per run in the conversation it runs in, a room's or a one-on-one chat's.
import type { GroupGoalRunCardData, GroupGoalRunStatus } from "../../shared/group-goal-run.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { GROUP_GOAL_MAX_TURNS } from "../group-goal-run.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { RoutineManager, RoutineRun } from "../routines.ts";
import type { BotRecord, Message, Store } from "../store.ts";

export interface LiveGoalRun {
  runId: string;
  cardMessageId: string;
  goal: string;
  coordinatorBotId: string;
  coordinatorName: string;
  turnCount: number;
  maxTurns: number;
  startedAt: number;
  finished: boolean;
}

export interface GoalCardDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage">;
  routines(): Pick<RoutineManager, "finishGoalRun"> | null;
  notify(notification: Notification | null): void;
  routineSourceOwner(run: RoutineRun): { bot: BotRecord } | null;
  routineSourceThread(run: RoutineRun): string | null;
}

export function createGoalCards(deps: GoalCardDeps) {
  const { store } = deps;

  function start(threadId: string, coordinator: Pick<BotRecord, "id" | "name" | "color">, goal: string, runId: string): LiveGoalRun {
    const startedAt = Date.now();
    const detail = `${coordinator.name} is coordinating this goal.`;
    const card = store.appendMessage(threadId, {
      role: "bot",
      kind: "goal.run",
      text: `Goal in progress: ${detail}`,
      from: { botId: coordinator.id, name: coordinator.name, color: coordinator.color },
      goalRun: {
        runId,
        goal,
        status: "working",
        coordinatorBotId: coordinator.id,
        coordinatorName: coordinator.name,
        turnCount: 0,
        maxTurns: GROUP_GOAL_MAX_TURNS,
        detail,
        startedAt,
      },
    });
    return {
      runId,
      cardMessageId: card.id,
      goal,
      coordinatorBotId: coordinator.id,
      coordinatorName: coordinator.name,
      turnCount: 0,
      maxTurns: GROUP_GOAL_MAX_TURNS,
      startedAt,
      finished: false,
    };
  }

  /** `stillHere` is false once the conversation is gone: the routine still settles, the card is not touched. */
  function finish(
    threadId: string,
    run: LiveGoalRun | undefined,
    status: Exclude<GroupGoalRunStatus, "working">,
    detail: string,
    stillHere: () => boolean,
  ): void {
    if (!run || run.finished) return;
    run.finished = true;
    const finishedAt = Date.now();
    const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
    const card: GroupGoalRunCardData = {
      runId: run.runId,
      goal: redactSecretsInText(run.goal),
      status,
      coordinatorBotId: run.coordinatorBotId,
      coordinatorName: redactSecretsInText(run.coordinatorName),
      turnCount: run.turnCount,
      maxTurns: run.maxTurns,
      detail: safeDetail,
      startedAt: run.startedAt,
      finishedAt,
    };
    const routineRun = deps.routines()?.finishGoalRun(run.runId, status, safeDetail);
    // A scheduled team goal that stops to ask must never be filed as a quiet completion.
    if (routineRun?.status === "waiting") {
      const coordinator = store.bot(routineRun.botId);
      if (coordinator) {
        const notificationBot = deps.routineSourceOwner(routineRun)?.bot ?? coordinator;
        deps.notify(buildNotification(
          "question",
          notificationBot,
          deps.routineSourceThread(routineRun) ?? routineRun.threadId ?? threadId,
          safeDetail || `${routineRun.routineName} needs your input`,
          { avatarUrl: notificationBot.avatarUrl },
        ));
      }
    }
    if (routineRun?.status === "completed") {
      const coordinator = store.bot(routineRun.botId);
      if (coordinator) {
        const notificationBot = deps.routineSourceOwner(routineRun)?.bot ?? coordinator;
        deps.notify(buildNotification(
          "done",
          notificationBot,
          deps.routineSourceThread(routineRun) ?? routineRun.threadId ?? threadId,
          safeDetail || routineRun.routineName,
          { avatarUrl: notificationBot.avatarUrl },
        ));
      }
    }
    if (!stillHere()) return;
    const fallbackState = status === "completed"
      ? "completed"
      : status === "needs-input"
        ? "needs your input"
        : status === "limit-reached"
          ? "reached its limit"
          : status;
    store.patchMessage(threadId, run.cardMessageId, {
      text: `Goal ${fallbackState}: ${card.detail || card.goal}`,
      goalRun: card,
    });
  }

  function progress(threadId: string, run: LiveGoalRun | undefined, detail: string): void {
    if (!run || run.finished) return;
    const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
    const current = store.messagesFor(threadId).find((message: Message) => message.id === run.cardMessageId);
    if (current?.goalRun?.status === "working" && current.goalRun.detail === safeDetail) return;
    store.patchMessage(threadId, run.cardMessageId, {
      text: `Goal in progress: ${safeDetail || redactSecretsInText(run.goal)}`,
      goalRun: {
        runId: run.runId,
        goal: redactSecretsInText(run.goal),
        status: "working",
        coordinatorBotId: run.coordinatorBotId,
        coordinatorName: redactSecretsInText(run.coordinatorName),
        turnCount: run.turnCount,
        maxTurns: run.maxTurns,
        ...(safeDetail ? { detail: safeDetail } : {}),
        startedAt: run.startedAt,
      },
    });
  }

  return { start, finish, progress };
}

export type GoalCards = ReturnType<typeof createGoalCards>;
