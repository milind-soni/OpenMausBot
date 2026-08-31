/** Durable progress receipt for one goal-driven channel run. */
export type GroupGoalRunStatus =
  | "working"
  | "completed"
  | "needs-input"
  | "blocked"
  | "limit-reached"
  | "stopped"
  | "failed";

export interface GroupGoalRunCardData {
  runId: string;
  goal: string;
  status: GroupGoalRunStatus;
  coordinatorBotId: string;
  coordinatorName: string;
  turnCount: number;
  maxTurns: number;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}
