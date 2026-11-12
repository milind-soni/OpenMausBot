/** One burst: one person's task split into many threads of the same bot, run in parallel, merged into one result. */
export type BurstPhase = "preview" | "running" | "merging" | "done" | "cancelled";
export type BurstChildStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type BurstCounts = Record<BurstChildStatus, number>;

/** The card in the parent chat: a preview until the person presses Run, then the one progress card, patched in place. It
 * carries counts only, and the rows come from GET /api/bursts/<id>, so a card stays one small row however large the burst. */
export interface BurstCardData {
  version: 1;
  burstId: string;
  botId: string;
  task: string;
  phase: BurstPhase;
  /** Tasks that run. */
  total: number;
  /** Tasks the bot proposed: more than `total` when the plan's task limit cut the list. */
  requested: number;
  /** How many run at once here. */
  parallel: number;
  /** The plan's most tasks per burst, set when it cut this list. */
  taskLimit?: number;
  /** Set on a plan where a higher one runs more at once. */
  smallPlan?: true;
  modelName: string;
  /** A rough figure for the preview, in minutes. */
  estimateMinutes: number;
  counts: BurstCounts;
  /** The first few tasks, for the preview. */
  sample: string[];
  /** Parts that did not finish, named once the burst settles, with `failedMore` counting past the ones listed. */
  failed?: BurstFailure[];
  failedMore?: number;
}

export interface BurstFailure {
  title: string;
  reason: string;
}

/** One part of a burst, as GET /api/bursts/<id> lists it. `threadId` is absent until it starts. */
export interface BurstChildRow {
  seq: number;
  title: string;
  status: BurstChildStatus;
  threadId?: string;
  error?: string;
}

export interface BurstView {
  burstId: string;
  phase: BurstPhase;
  instructions: string;
  items: string[];
  children: BurstChildRow[];
}
