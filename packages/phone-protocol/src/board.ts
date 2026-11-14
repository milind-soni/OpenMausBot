// The project board's wire contract: projects, subprojects, milestones and one classification per
// conversation. A board task never carries a conversation's title or messages: clients join it with the
// bot snapshot they already have, by botId + threadId.

export const BOARD_PHASES = ["discovery", "design", "build", "test", "release_ready", "live_unverified", "done"] as const;
export type BoardPhase = (typeof BOARD_PHASES)[number];

export const BOARD_TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type BoardTaskStatus = (typeof BOARD_TASK_STATUSES)[number];

export const BOARD_MILESTONE_STATUSES = ["planned", "in_progress", "accepted", "rejected"] as const;
export type BoardMilestoneStatus = (typeof BOARD_MILESTONE_STATUSES)[number];

export const BOARD_VERDICTS = ["accepted", "rejected"] as const;
export type BoardVerdict = (typeof BOARD_VERDICTS)[number];

export interface BoardProject {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSubproject {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardMilestone {
  id: string;
  projectId: string;
  subprojectId?: string;
  title: string;
  status: BoardMilestoneStatus;
  /** Required, with `evidence`, once accepted. */
  verdict?: string;
  evidence?: string;
  /** Epoch ms; display only. */
  dueAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardTaskVerdictRecord {
  decision: BoardVerdict;
  evidence: string;
  at: string;
}

/** One conversation's place on the board. `threadId` is its identity; `botId` never changes after the first write. */
export interface BoardTask {
  threadId: string;
  botId: string;
  projectId?: string;
  subprojectId?: string;
  /** Another board task's threadId: the larger piece of work this one belongs under. */
  parentThreadId?: string;
  phase: BoardPhase;
  status: BoardTaskStatus;
  owner?: string;
  acceptance?: string;
  blocked?: boolean;
  paused?: boolean;
  /** A person's verdict on this piece of work; `done` needs an accepted one. */
  verdict?: BoardTaskVerdictRecord;
  createdAt: string;
  updatedAt: string;
}

/** Everything the board stores, without a caller's capability. Broadcast as a whole on every write. */
export interface BoardState {
  version: number;
  projects: BoardProject[];
  subprojects: BoardSubproject[];
  milestones: BoardMilestone[];
  tasks: BoardTask[];
  updatedAt: string;
}

export interface BoardCapabilities {
  /** Only an owner/admin may create or change anything; everyone else reads. */
  manage: boolean;
}

export interface BoardSnapshot extends BoardState {
  capabilities: BoardCapabilities;
}

/** An SSE frame: the whole board each time, so a client replaces its copy and never merges a stale one. */
export interface BoardBroadcast {
  kind: "board";
  board: BoardState;
}
