/** Exact native job and source-conversation fence returned before a Chief cancels work. */
export interface JobCancellationSnapshot {
  rootId: string;
  sourceBotId: string;
  sourceThreadId: string;
  requestMessageId: string;
  generation: string;
  treeVersion: string;
  activeLeafId: string | null;
  activeTurnId: string | null;
  executionId: string | null;
}

/** Native cancellation is recorded separately from local interruption failures. */
export interface JobCancellationResult {
  rootId: string;
  state: "cancelled" | "partial";
  stoppedIds: string[];
  activeIds: string[];
  errors: string[];
  alreadyCancelled?: boolean;
}
