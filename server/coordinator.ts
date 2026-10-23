      import { RuntimeCoordinator } from "./runtime-coordinator.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import type { LegacyThreadResolver } from "./runtime/import-legacy.ts";
import type { Assignment, EnvelopeNames, Level, Limits, Mode, Origin, Outcome, Owner, Reply, Requester, StatusView, TurnEvidence } from "./runtime/types.ts";

/** One coordinate_bots call, as the internal route hands it to the server. */
export type CoordinateBotsCall = {
  groupId?: string;
  botIds: string[];
  message: string;
  reason?: string;
  rework: boolean;
  thread: "standing" | "new";
  reply: "resume" | "none";
  consult: boolean;
  inMyFolder?: boolean;
  doneWhen?: string;
  title?: string;
  projectId?: string;
};

export type { LegacyThreadResolver };

export type HandoffStatus = "source" | "queued" | "running" | "waiting" | "resume" | "completed" | "failed" | "cancelled";

 export interface HandoffView {
  id: string;
  rootId: string;
  parentId?: string;
  groupId?: string;
  threadId: string;
  botId: string;
  key: string;
  text: string;
  createdAt: number;
  requestBatchKey?: string;
  status: HandoffStatus;
  result: string;
  reported: boolean;
  executions: number;
  startedAt?: number;
  lastProgressAt?: number;
  approvalGranted: boolean;
  /** Recorded grant ceiling, refreshed before dispatch. */
  level: Level;
  kind: "work" | "assignment";
  /** Immutable runtime lineage, distinct from evidence of a user request. */
  originKind?: Origin["kind"];
  origin?: WorkOrigin;
  restarts: number;
  restart?: "rerun" | "cut" | "teammates";
  /** work: do it; consult: answer, act on nothing; notify: one-way. */
  mode: Mode;
  /** resume: the requester is woken; poll: it reads its inbox; none: nothing comes back. */
  reply: Reply;
  outcome?: Outcome;
  outcomeDetail?: string;
  question?: string;
  cards?: string[];
  continuation?: { note: string; handoffPath?: string; count: number };
  goalRunId?: string;
}

 export interface BeginTurnRequest {
  id: string;
  address: RoomAddress;
  brief: string;
  level: Level;
  opener?: HandoffOpener;
  origin?: WorkOrigin;
  goalRunId?: string;
}

 export interface HostTurnResult {
  ok: boolean;
  text: string;
  evidence?: TurnEvidence;
  cap?: { note: string; handoffPath?: string };
  cards?: { question: string; ids: string[] };
  /** The host's stall watchdog stopped the turn, including a room turn a stall ended during setup, before it had an
   * outcome: it failed as `stalled`, not as a provider error. */
  stalled?: boolean;
}

 export interface HandoffOpener {
  requester: Requester;
  origin: Origin;
}

export interface HandoffOptions {
  mode?: Mode;
  reply?: Reply;
  thread?: "standing" | "new";
  approvalGranted?: boolean;
  rework?: boolean;
  requestBatchKey?: string;
  doneWhen?: string;
}

export type RoomAddress = Pick<HandoffView, "groupId" | "threadId" | "botId">;

 export interface ComposedTurn {
  text: string;
  note: string;
  restartNote: string;
  turn: "first" | "resume" | "rerun" | "answered" | "continued";
}

export interface LiveHandoffEdge {
  sourceBotId: string;
  targetBotId: string;
  state: "queued" | "running";
  threadId: string;
  groupId?: string;
}

 export interface CoordinatorHost {
  /** Recheck addresses and route permission immediately before every dispatch. */
  validate(node: HandoffView, parent?: HandoffView): string | undefined;
  busy(node: HandoffView): boolean;
  run(node: HandoffView, resumed: boolean, signal: AbortSignal, composed: ComposedTurn): Promise<HostTurnResult>;
  report(child: HandoffView, parent?: HandoffView): void;
  changed(groupIds: ReadonlySet<string>, directThreadIds: ReadonlySet<string>): void;
  names(node: HandoffView, parent?: HandoffView): EnvelopeNames;
  park(node: HandoffView, question: string, restored?: boolean): void;
  levelOf(target: RoomAddress, source?: RoomAddress, origin?: Origin["kind"], mode?: Mode): { level: Level; driverKind?: string };
  chiefOf(address: RoomAddress): boolean;
  outward?(node: HandoffView): string[];
}

export interface Coordinator {
  node(id: string): HandoffView | undefined;
  has(id: string): boolean;
  all(): HandoffView[];
  active(): HandoffView[];
  children(id: string): HandoffView[];
  enqueue(source: RoomAddress, generation: string, parentId: string | undefined, target: RoomAddress, text: string,
    options?: HandoffOptions): { node: HandoffView; duplicate: boolean };
  status(id: string): StatusView | undefined;
  job(threadId: string, since: number, botId?: string): { scopes: string[]; rows: Assignment[] };
  /** Undelivered inbox items for a polling requester, marked delivered. */
  poll(owner: Owner): { items: StatusView["inbox"]; assignments: HandoffView[] };
  /** Non-terminal work the conversation in this thread is waiting on, rooms included. */
  outstandingFor(threadId: string): HandoffView[];
  beginTurn(req: BeginTurnRequest): HandoffView;
  endTurn(id: string, result: HostTurnResult): void;
  answerNode(id: string, text: string): boolean;
  answerRoot(id: string, text: string): boolean;
  parkedDirect(threadId: string): HandoffView | undefined;
  prune(before: number): number;
  sharedRequest(node: HandoffView): { id: string; botIds: string[] };
  cancelRoom(groupId: string, threadId?: string, reason?: string, status?: "failed" | "cancelled"): void;
  cancelDirect(threadId: string, reason?: string): void;
  activeDirect(threadId: string): boolean;
  assignerOf(threadId: string): HandoffView | undefined;
  outstandingDirect(threadId: string): HandoffView[];
  /** Direct conversations whose turn waits on teammates: an open handoff it made that owes a reply, or a root parked to resume with no question for the person. */
  awaitingTeammateThreads(): Set<string>;
  liveEdges(): LiveHandoffEdge[];
  stopAwaitingDirect(threadId: string, reason?: string): HandoffView[];
  continuesAfterRestart(threadId: string): boolean;
  note(id: string): string | undefined;
  tick(): void;
  close(): void;
  progress(threadId: string): void;
  answer(threadId: string, text: string): boolean;
  awaitingAnswer(threadId: string): boolean;
}

export interface CoordinatorOptions {
  dataDir: string;
  host: CoordinatorHost;
  now?: () => number;
  runtimeLimits?: Partial<Limits>;
  log?: (line: string) => void;
  legacyThreads?: LegacyThreadResolver;
}

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  return new RuntimeCoordinator(options);
}
