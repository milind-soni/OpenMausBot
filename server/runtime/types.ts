          import type { ApprovalMode } from "../../shared/approval-mode.ts";


/** Where the work ultimately started. Immutable down the whole tree. */
export type OriginKind = "person" | "routine" | "outside";
 export type OriginSource = "chat" | "routine" | "webhook" | "relay" | "external_runtime" | "guest" | "peer" | "api";

export interface Origin {
  kind: OriginKind;
  source: OriginSource;
  /** The thread, routine or webhook the work came from, when known. */
  ref?: string;
  quote?: string;
  onBehalfOf?: string;
}

export type RequesterKind = "person" | "bot_turn" | "routine_run" | "external_runtime";

export interface Requester {
  kind: RequesterKind;
  /** The bot whose turn or run asked (absent for a person or an external runtime). */
  botId?: string;
  /** The conversation the result returns to (absent for an external runtime). */
  threadId?: string;
  /** The routine run or the external runtime's own reference. */
  runId?: string;
  /** The requester is a Chief of Staff conversation: its level may flow down. */
  chief?: boolean;
}

export type DestinationKind = "work_thread" | "standing_thread" | "room_thread";

export interface Assignee {
  botId: string;
  destination: { kind: DestinationKind; threadId: string; groupId?: string };
}


/** work: do it with your own tools. consult: answer from what you know, act
 * on nothing. notify: one-way, nothing comes back. */
export type Mode = "work" | "consult" | "notify";
/** resume: the requester is woken with the result. poll: the result waits
 * in the inbox for status(). none: no inbox entry (notify). */
export type Reply = "resume" | "poll" | "none";

export type Status =
  | "queued"          // accepted, not yet admitted
  | "running"         // a turn of the assignee is executing it
  | "needs_input"     // parked on the person (a card or a NEEDS INPUT line)
  | "waiting"         // its turn ended after handing out work; waits on children
  | "resume"          // every child settled, or one it waits on parked a new question; owes its own follow-up turn
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL: readonly Status[] = ["completed", "failed", "cancelled"];

/** Why it ended the way it did, typed so a requester can branch on it. */
export type Outcome =
  | "done"
  | "needs_input"      // ended with a question the person has not answered
  | "cap_continued"    // a step cap was hit and the work continued in place
  | "stalled"
  | "interrupted"      // a restart, reload or sleep cut it and it was not resumed again
  | "budget"
  | "provider_error"
  | "denied"           // a permission the level did not cover was refused
  | "expired"          // a wait on the person ran out: not run, not refused
  | "stopped"          // the person stopped it
  | "refused"          // validation refused it at dispatch
  | "duplicate";

export type Level = ApprovalMode;
export type LevelSource = "own" | "chief" | "engine_cap";

export interface Assignment {
  id: string;
  rootId: string;
  parentId?: string;
  /** Edges from the root: a root is 0. */
  depth: number;
  origin: Origin;
  requester: Requester;
  assignee: Assignee;
  mode: Mode;
  reply: Reply;
  /** The request, harness-stored (at most 12 000 characters). */
  brief: string;
  /** The requester's own completion criterion, if it gave one. */
  doneWhen?: string;
  goalRunId?: string;
  status: Status;
  outcome?: Outcome;
  outcomeDetail?: string;
  level: Level;
  levelSource: LevelSource;
  /** Turns started for it, including resumes and reruns. */
  executions: number;
  /** Turns of it a restart cut and ran again in place. */
  restarts: number;
  restart?: "rerun" | "cut" | "teammates";
  createdAt: number;
  startedAt?: number;
  /** Last durable progress: a dispatch, a settlement, a child's settlement. */
  lastActivityAt: number;
  finishedAt?: number;
  /** What the assignee last said or how it ended (at most 12 000 characters). */
  result: string;
  /** What the harness observed of the turn (commands, files, tool counts),
   * attached to the report as evidence. Never model text. */
  evidence?: TurnEvidence;
  /** The report reached the requester's conversation. */
  reportedAt?: number;
  /** The same brief to the same assignee under one parent is one request;
   * a repeat lands on it unless rework is set. */
  rework: boolean;
  question?: string;
  /** The person's answer, harness-quoted, carried into the next turn. */
  answer?: string;
  /** On a root only: the budget window since its last durable progress. */
  budgets?: { since: number; requests: number; executions: number; wakes: number };
  /** While parked on the person's cards (a root): the ids of the cards the
   * turn left open; the answer arrives when the person acts on them. */
  cards?: string[];
  /** The next execution continues the last one in place: after a step cap,
   * or a wait the host could not hold (a computer seat). Cleared at dispatch. */
  continuation?: { note: string; handoffPath?: string; count: number };
  guard?: { stale: number; errors: string[] };
  /** While a turn runs: the awaited children whose open questions its input carries. A restart that cuts the turn
   * reruns it with them once more; no other turn carries them again. */
  carrying?: string[];
  /** A peer-review card allowed this before it was sent. */
  approved?: boolean;
  /** A room brief shown once per call: every recipient of that call shares it. */
  batchKey?: string;
  version: 1;
}

export interface TurnEvidence {
  commands?: number;
  filesChanged?: string[];
  toolCalls?: number;
  summary?: string;
  /** Tool calls of this execution that returned ok. */
  okToolCalls?: number;
  /** The tool error texts of this execution, oldest first, at most 3, each clipped to 200 chars. */
  errors?: string[];
  /** Outward actions this execution completed — sends, posts, publishes, commits, pushes, payments —
   * as short labels ("GMAIL_SEND_EMAIL", "git push", "COMPOSIO_PROXY_EXECUTE"). */
  outward?: string[];
}

export type EventKind =
  | "level_changed"
  | "enqueued" | "refused" | "admitted" | "started" | "progress" | "parked" | "answered"
  | "waiting" | "resume_due" | "settled" | "reported" | "woken" | "cancelled"
  | "restart_reconciled" | "budget" | "stalled" | "continued";

export interface AssignmentEvent {
  id: number;
  assignmentId: string;
  at: number;
  kind: EventKind;
  detail?: string;
}

export type InboxKind = "settled" | "needs_input" | "stalled";

/** The one wake lane: a requester learns about its work only through this. */
export interface InboxItem {
  id: string;
  ownerBotId?: string;
  ownerThreadId?: string;
  /** External runtimes poll by run id instead of a thread. */
  ownerRunId?: string;
  assignmentId: string;
  kind: InboxKind;
  createdAt: number;
  deliveredAt?: number;
}


export interface EnqueueRequest {
  parentId?: string;
  origin: Origin;
  requester: Requester;
  assignee: Assignee;
  mode?: Mode;
  reply?: Reply;
  brief: string;
  doneWhen?: string;
  rework?: boolean;
  /** The requester's own level and, for a Chief lineage, the Chief
   * conversation's level, as the harness knows them. */
  levels: { own: Level; chief?: Level };
  driverKind?: string;
  approved?: boolean;
  batchKey?: string;
}

export type EnqueueResult =
  | { ok: true; assignment: Assignment; duplicate: boolean }
  | { ok: false; reason: string; outcome: "refused" | "budget" | "duplicate" };


export interface RunInput {
  /** first; resume (returns settled children's results and awaited children's open questions); rerun (after a restart cut it); answered; continued. */
  turn: "first" | "resume" | "rerun" | "answered" | "continued";
  /** Not the node's first turn (any `turn` but "first"). */
  resumed: boolean;
  /** What the restart did, for the first line of the turn ("" when nothing). */
  restartNote: string;
  envelope: string;
  /** The person's answer to the question this assignment was parked on. */
  answer?: string;
  /** The settled children whose results this (resume) turn returns. */
  settled?: Assignment[];
  /** The awaited children parked on a question this turn passes on: a question not yet delivered, or, in the rerun
   * of a turn a restart cut, the questions that turn carried. */
  asked?: Assignment[];
  /** For a continued turn: why it continues and, after a step cap, where
   * the steps so far are listed. */
  continuation?: { note: string; handoffPath?: string };
  level: Level;
  mode: Mode;
}

export type RunResult =
  | { kind: "completed"; text: string; evidence?: TurnEvidence }
  | { kind: "failed"; outcome: Exclude<Outcome, "done" | "needs_input">; text: string; evidence?: TurnEvidence }
  | { kind: "needs_input"; question: string; cards?: string[]; evidence?: TurnEvidence }
  /** The turn stopped short (a step cap, a seat it could not get) and the
   * same node continues in place with its next execution. */
  | { kind: "continue"; text: string; note: string; handoffPath?: string; evidence?: TurnEvidence };

/** How a host-run root turn ended (Runtime.end). */
export interface EndResult {
  ok: boolean;
  text: string;
  evidence?: TurnEvidence;
  /** The turn left the person something to act on: it parks until they do. */
  needsInput?: { question: string; cards?: string[] };
  /** The turn stopped short and continues in place. */
  continue?: { note: string; handoffPath?: string };
  /** The host's stall watchdog stopped the turn. */
  stalled?: boolean;
}

export interface Owner {
  botId?: string;
  threadId?: string;
  runId?: string;
}

/** Display names the envelope needs. The host owns names; the runtime
 * owns ids. */
export interface EnvelopeNames {
  requester: string;
  assignee: string;
  /** The person the work is for, when the origin is a person. */
  person?: string;
  /** The requester conversation's title, when there is one. */
  thread?: string;
}

 export interface TurnRunner {
  /** Recheck addresses and routes right before every dispatch. A string
   * refuses the assignment with that reason. */
  validate(a: Assignment, parent?: Assignment): string | undefined;
  /** Whether the assignee can take a turn now. A string says why not, once,
   * where the work was sent; false waits silently. */
  canStart(a: Assignment): true | false | string;
  /** Recheck a queued or resumed grant before composing the envelope. */
  approvalLevel?(a: Assignment): { level: Level; source: LevelSource };
  /** Run one turn of the assignee. Resolves when the engine settles. The
   * signal aborts the turn (a cancel or a stop). */
  run(a: Assignment, input: RunInput, signal: AbortSignal): Promise<RunResult>;
  /** The assignment is parked on the person; show what it needs. `restored`
   * is the restart's re-park: show it again only if it never got shown. */
  park(a: Assignment, question: string, restored?: boolean): void;
  /** A settled child, into its requester's conversation (a chip, a line), or
   * a root that ended alone, into its own. Called once per settlement. */
  report(a: Assignment, parent?: Assignment): void;
  /** Rows changed: refresh what shows them. */
  changed(assignments: readonly Assignment[]): void;
  /** Display names for the envelope of a turn (ids are the fallback). */
  names(a: Assignment, parent?: Assignment): EnvelopeNames;
  outward?(a: Assignment): string[];
}

export interface Clock {
  /** Wall-clock milliseconds, for timestamps. */
  now(): number;
  /** Monotonic milliseconds that do not advance while the host sleeps, for
   * stall windows. */
  monotonic(): number;
}

export interface Limits {
  /** Edges from the root a child may sit at. */
  depth: number;
  /** Per root, counted since the root's last progress. */
  requests: number;
  executions: number;
  wakes: number;
  /** A queued assignment that never started within this is expired. */
  queueMs: number;
  /** No durable progress on a root for this long fails the tree. */
  stallMs: number;
  /** A turn with no activity for this long is stalled (the host says what
   * counts as activity by touching progress()). */
  turnStallMs: number;
  /** How long a parked assignment waits on the person before it expires:
   * not run, not refused. */
  inputWaitMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  depth: 4,
  requests: 24,
  executions: 48,
  wakes: 48,
  queueMs: 24 * 60 * 60_000,
  stallMs: 4 * 60 * 60_000,
  turnStallMs: 20 * 60_000,
  inputWaitMs: 30 * 60_000,
};


export interface LiveEdge {
  sourceBotId: string;
  targetBotId: string;
  state: "queued" | "running" | "needs_input" | "waiting";
  threadId: string;
  groupId?: string;
}

export interface StatusView {
  assignment: Assignment;
  children: Assignment[];
  inbox: InboxItem[];
}

export const terminal = (status: Status): boolean => TERMINAL.includes(status);
