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

export const BOARD_PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;
export type BoardProjectStatus = (typeof BOARD_PROJECT_STATUSES)[number];

/** Same shape as a bot's sharing: who may read a project. Missing means admins only after migration. */
export type BoardVisibility = "everyone" | "admins" | { people: string[] };

export interface BoardProject {
  id: string;
  name: string;
  description?: string;
  /** Display name of the person accountable for the project. */
  owner?: string;
  /** The authenticated person who may edit the project without being an admin. */
  ownerEmail?: string;
  goal?: string;
  /** Completion standard, distinct from any task's acceptance. */
  acceptance?: string;
  status?: BoardProjectStatus;
  visibility?: BoardVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSubproject {
  id: string;
  projectId: string;
  name: string;
  /** The subproject's own product phase; tasks separately record their status. */
  phase?: BoardPhase;
  /** What moved the subproject into `phase`. */
  phaseEvidence?: string;
  owner?: string;
  ownerEmail?: string;
  deliverable?: string;
  acceptance?: string;
  status?: BoardProjectStatus;
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
  /** The authenticated person whose verdict accepted it. */
  acceptedBy?: string;
  /** What must be true for acceptance, recorded before the verdict. */
  acceptance?: string;
  owner?: string;
  ownerEmail?: string;
  /** Epoch ms; display only. */
  dueAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardTaskVerdictRecord {
  decision: BoardVerdict;
  evidence: string;
  at: string;
  /** Who recorded the verdict; never taken from a request body. */
  by?: string;
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
  /** What moved the task's product phase; required when the phase is first set to done. */
  phaseEvidence?: string;
  status: BoardTaskStatus;
  owner?: string;
  /** The authenticated person who may change this task without owning the project. */
  ownerEmail?: string;
  acceptance?: string;
  blocked?: boolean;
  /** Why the work is blocked; kept beside the boolean so old clients still see the flag. */
  blockedReason?: string;
  paused?: boolean;
  pausedReason?: string;
  /** A person's verdict on this piece of work; `done` needs an accepted one. */
  verdict?: BoardTaskVerdictRecord;
  createdAt: string;
  updatedAt: string;
}

export interface BoardAuditEntry {
  id: string;
  at: string;
  actor: { label: string; email?: string };
  action: "project.create" | "project.update" | "subproject.create" | "subproject.update" | "milestone.create" | "milestone.update" | "task.link" | "task.update" | "task.verdict" | "task.remove" | "task.batch";
  target: { kind: "project" | "subproject" | "milestone" | "task"; id: string };
  /** Changed field names only; transcript text and evidence bodies never land in the audit. */
  fields: string[];
  /** Batch size, when one action covers many tasks. */
  count?: number;
  /** A failed batch's reason; a successful entry omits it. */
  reason?: string;
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
  /** An owner/admin may create projects and change anything; a project or task owner has the narrower writes listed in `permissions`. */
  manage: boolean;
}

export interface BoardCounts {
  tasks: number;
  /** Tasks with no visible parent; a parent and its children never count twice. */
  topLevel: number;
  subtasks: number;
  done: number;
}

export interface BoardSnapshot extends BoardState {
  capabilities: BoardCapabilities;
  /** Per-object write access for the caller; absent on broadcasts, which carry no capabilities. */
  permissions?: {
    projects: Record<string, boolean>;
    tasks: Record<string, boolean>;
    milestones: Record<string, boolean>;
  };
  counts?: BoardCounts;
}

/** An SSE frame: the whole board each time, so a client replaces its copy and never merges a stale one. */
export interface BoardBroadcast {
  kind: "board";
  board: BoardState;
}
