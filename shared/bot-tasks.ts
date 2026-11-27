// Bot tasks: the bots-only task ledger (docs/bot-tasks.md). These are the wire types the server, the bot tools and the app
// share; the server keeps them in `bot-tasks.json` in the data folder.

export const BOT_TASK_STATUSES = ["open", "in_progress", "blocked", "review", "done", "cancelled"] as const;
export type BotTaskStatus = (typeof BOT_TASK_STATUSES)[number];

export const BOT_TASK_LIMITS = {
  titleMax: 160,
  textMax: 4000,
  activityMax: 400,
  tasksMax: 2000,
  evidencePerMove: 10,
  listMax: 50,
} as const;

/** A pull request or an issue on GitHub, as `owner/repo#number`. `kind` is learned from GitHub on the first sync. */
export interface BotTaskGithubRef {
  repo: string;
  number: number;
  kind?: "pull" | "issue";
}

/** What a caller says backs a claim: one of these is needed to move a task to done (and to review, when that setting is on). */
export type BotTaskEvidenceClaim =
  | { kind: "commit"; sha: string; repo?: string }
  | { kind: "ci_run"; url: string }
  | { kind: "review_url"; url: string }
  | { kind: "command"; command: string; exitCode: number };

/** What GitHub said when the app looked the claim up. `unverifiable`: no answer was possible (no linked or allowed repository,
 * no credential, GitHub unreachable, a CI run still going); a `failed` check blocks the move. `detail` is a short plain line. */
export interface BotTaskVerification {
  status: "verified" | "failed" | "unverifiable";
  checkedAt: number;
  detail?: string;
}

/** A claim as it is stored: the server adds `verification`; a caller never supplies it. */
export type BotTaskEvidence = BotTaskEvidenceClaim & { verification?: BotTaskVerification };

export type BotTaskActor = { kind: "bot"; id: string; name: string } | { kind: "person"; name: string } | { kind: "github"; login: string } | { kind: "system" };

/** One line of a task's append-only log. `key` is set for events imported from GitHub, so a later poll never adds one twice. */
export type BotTaskActivity = {
  id: string;
  at: number;
  by: BotTaskActor;
  key?: string;
  /** From GitHub history older than the link to the task: `at` is the original GitHub time, not the time of the import. */
  imported?: true;
} & (
  | { type: "created" }
  | { type: "comment"; text: string }
  | { type: "status"; from: BotTaskStatus; to: BotTaskStatus; evidence?: BotTaskEvidence[] }
  | { type: "owner"; from?: string; to: string }
  | { type: "github_ref"; ref: BotTaskGithubRef }
  | { type: "github_comment"; text: string; url?: string }
  | { type: "github_review"; state: string; text: string; url?: string }
  | { type: "github_check"; name: string; conclusion: string; url?: string }
  | { type: "github_state"; state: "merged" | "closed" | "reopened"; url?: string }
  | { type: "posted"; url: string; merged?: boolean }
  | { type: "sync_error"; text: string }
);

/** An activity entry without its id, time, author and import key: what a caller says happened. */
export type BotTaskActivityBody = BotTaskActivity extends infer Entry ? (Entry extends unknown ? Omit<Entry, "id" | "at" | "by" | "key" | "imported"> : never) : never;

export interface BotTask {
  id: string;
  title: string;
  status: BotTaskStatus;
  ownerBotId: string;
  createdBy: BotTaskActor;
  createdAt: number;
  updatedAt: number;
  github?: BotTaskGithubRef;
  /** The last GitHub state seen by a sync; used only to show it and to detect changes. */
  githubState?: { state: "open" | "closed" | "merged"; syncedAt: number; historyBackfilled?: true };
  /** Evidence attached to the current status. */
  evidence?: BotTaskEvidence[];
  activity: BotTaskActivity[];
}

export interface BotTaskSummary extends Omit<BotTask, "activity" | "evidence"> {
  ownerName: string;
  activityCount: number;
  /** How many evidence items the current status carries; 0 when it has none. */
  evidenceCount?: number;
  /** What GitHub said about that evidence: `verified` when any item checked out, else `failed`, else `unverifiable`
   * (a recorded command is only the bot's own word, so it is never better than that). Absent when there is no evidence. */
  evidenceStatus?: BotTaskVerification["status"];
}

/** `botTasks` in config.json, and what Settings shows. `credential: "vault"` reads a token kept in the Vault (never in config.json);
 * it is never sent to the app: Settings learns only `githubTokenSet`. */
export interface BotTasksSettings {
  enabled: boolean;
  githubSync: boolean;
  pollMinutes: number;
  repos: string[];
  credential: "gh" | "vault";
  requireEvidenceForDone: boolean;
  requireEvidenceForReview: boolean;
  allowOutboundComments: boolean;
  allowMerge: boolean;
}

export const BOT_TASKS_DEFAULTS: BotTasksSettings = {
  enabled: false,
  githubSync: false,
  pollMinutes: 5,
  repos: [],
  credential: "gh",
  requireEvidenceForDone: true,
  requireEvidenceForReview: false,
  allowOutboundComments: false,
  allowMerge: false,
};

export const BOT_TASKS_POLL_MINUTES = { min: 1, max: 1440 } as const;

/** `owner/repo`; a segment of only dots (`..`) is not a name, so the pattern cannot be used to climb a URL path. */
export const REPO_PATTERN = /^(?!\.+\/)(?!.*\/\.+$)[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
