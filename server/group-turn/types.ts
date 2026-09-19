// Shared types for the group-turn family modules (server/group-turn/).
// Moved verbatim from group-turn.ts when the engine's bodies were split
// into families; group-turn.ts re-exports them so index.ts's import path
// is unchanged.

export type GroupMemberTurnOutcome =
  | "settled"
  | "provider_failed"
  | "dispatch_failed"
  | "spend_capped"
  | "stalled"
  | "timed_out"
  | "cancelled"
  | "busy"
  | "unavailable";
export type GroupTurnOrchestration = {
  roomHandoffId?: string;
  resumed?: boolean;
  systemInstructions: string;
  turnInstructions?: string;
  followMentions: boolean;
  result: { replyText?: string; outcome?: GroupMemberTurnOutcome; stopReason?: string | null };
  onClaimed?: () => void;
  onTurnStarted?: (turnId: string) => void;
};

export type GroupTurnOperation = {
  id: string;
  threadId: string;
  botIds: Set<string>;
  cancelled: boolean;
  cancellation: AbortController;
  providerHandshakePending: boolean;
  goalRun?: {
    runId: string;
    cardMessageId: string;
    goal: string;
    coordinatorBotId: string;
    coordinatorName: string;
    turnCount: number;
    maxTurns: number;
    startedAt: number;
    finished: boolean;
  };
};
