import type { PlanRow, SendKind } from "./cloud-send-parts.mjs";

export type CloudSendPlace = "none" | "asleep" | "unreachable" | "outdated" | "signed-out" | "local-unavailable" | "ready";

export interface CloudSendResult {
  /** Bots added to My Cloud, by name. */
  bots: string[];
  /** Bots My Cloud had, updated with what changed here. */
  updatedBots: string[];
  skills: number;
  logins: number;
  onePassword: boolean;
  /** "profile" and/or "language". */
  settings: string[];
  /** Apps and keys a move carried (MCP servers, AI keys, mailboxes, connected apps); 0 or absent for any other send. */
  connections?: number;
  /** The chats My Cloud lacked, added by row or by Bring newer chats; null when this send did not bring chats. `left`:
   * conversations that did not all go this time (a bot answering in one, or My Cloud not taking a page yet). */
  chats: { conversations: number; messages: number; left?: number } | null;
  failed: Array<{ key: string; kind: SendKind | "chats" | "connection" | "memory" | "files"; label: string; error: string; final?: true }>;
  /** A move's own: automations and skill extras it carried, memory files and learned facts merged, bot files sent (`kept`:
   * beside a different file of My Cloud's), and conversations whose own settings it set. */
  moved?: number;
  memory?: number;
  files?: { sent: number; kept: number };
  conversationSettings?: number;
  /** model: kept My Cloud's engine; settings: a setting My Cloud refused; narrowed: a login kept to bots My Cloud lacks; memory: notes not copied;
   * held: a key a trial's Cloud keeps unused while its Claude credit lasts. */
  notes: Array<{ kind: "model" | "settings" | "narrowed" | "memory" | "held"; bot?: string; login?: string; connection?: string }>;
}
/** `error`: the send failed as a whole (nothing after that point went), in words for the person. */
export interface CloudSendOutcome { at: number; reason: string; result: CloudSendResult; error?: string }
/** What did not go, grouped by reason (bots by name, logins only counted, at most three reasons), and `error`: why the
 * send stopped as a whole. */
export interface CloudSendFailure {
  /** `connections`: apps and keys a move could not carry; absent from an older desktop. */
  reasons?: Array<{ what: { bots: string[]; skills: number; logins: number; onePassword: boolean; settings: number; connections?: number; chats: boolean }; error: string }>;
  error?: string;
}

export interface CloudSendSnapshot {
  cloud: CloudSendPlace;
  running: null | { reason: string; progress?: { done: number; total: number }; phase?: "chats" };
  rows: PlanRow[];
  cloudOnly: Array<{ key: string; kind: SendKind; label: string; detail?: string; bot?: string }>;
  pending: number;
  /** This computer's conversations still to go; null when My Cloud is too old to take chats by row, or not compared yet. */
  chats: { waiting: number } | null;
  signature: string;
  dismissed: string;
  last: CloudSendOutcome | null;
  /** The latest send of everything (Send everything, a move), which a later send of one login or item never replaces. */
  whole: CloudSendOutcome | null;
  /** What reached My Cloud from this computer, all sends together. */
  arrived: CloudSendArrived;
  cloudVersion: string | null;
  localVersion: string | null;
  /** A move's check under way: its step, `done` of `total` there, the bots it checks, and until when it waits for a My
   * Cloud that did not answer. */
  checking?: { step: string; done: number; total: number; bots: number; until?: number } | null;
}

/** What My Cloud's own page is told: names of this computer's bots that wait, and counts, never logins' sites. */
export interface CloudSendNotice {
  ready: boolean;
  /** Sent only by an older desktop whose Keep My Cloud up to date was on: its things come over by themselves. */
  auto?: boolean;
  bots: string[];
  updatedBots: string[];
  skills: number;
  logins: number;
  onePassword: boolean;
  settings: number;
  signature: string;
  dismissed: boolean;
  running: boolean;
  /** The running send's reason ("move": the one-time move of everything to My Cloud), progress and phase. */
  runningReason?: string;
  progress?: { done: number; total: number };
  phase?: "chats";
  /** `sent`: counts only; `seen`: the person closed this result on the strip. */
  /** `final`: every failure is one trying again can't fix (1Password refused the token), so no Try again. */
  last: CloudSendTold | null;
  /** The latest send of everything, which a send of one login or item never replaces; absent from an older desktop. */
  whole?: CloudSendTold | null;
  /** What reached My Cloud from this computer, all sends together; absent from an older desktop. */
  arrived?: CloudSendArrived;
  /** The one-time move's own line, while there is one; absent from an older desktop. */
  move?: import("./one-home.mjs").OneHomeView;
  /** On My Cloud's page: a bot moving into a team, while its line shows; absent from an older desktop. */
  teamMove?: import("./team-move.mjs").TeamMoveView;
  /** On this computer's page: some of its bots on their way to My Cloud. */
  botMove?: BotMoveView;
}
export type CloudSendTold = { at: number; reason: string; failed: number; seen: boolean; sent: CloudSendCounts; final?: boolean } & CloudSendFailure;
export interface CloudSendArrived extends CloudSendCounts { chats: { conversations: number; messages: number } }
export interface CloudSendCounts {
  bots: number; updatedBots: number; skills: number; logins: number; onePassword: boolean; settings: number;
  chats: { conversations: number; messages: number } | null;
}

export interface CloudSendPageBridge {
  notice(): Promise<CloudSendNotice>;
  dismiss(signature: string): Promise<CloudSendNotice>;
  /** The move's Try again, after a day of failing; absent from an older desktop. */
  moveRetry?(): Promise<CloudSendNotice>;
  onNotice(listener: (notice: CloudSendNotice) => void): () => void;
  /** On My Cloud's page: the teams a bot of its can move into, from the Admin's verified session; absent from an older desktop. */
  teams?(): Promise<{ teams: Array<{ id: string; name: string; ready: boolean }> }>;
  /** Moves one bot into one of those teams (a real click). */
  moveToTeam?(botId: string, teamId: string, name: string): Promise<import("./team-move.mjs").TeamMoveView | null>;
  /** `moveToTeam` with main's refusal as a value, which the page says in its own language; `moveToTeam` keeps rejecting
   * with the English only, for pages that predate this. Absent from an older desktop. */
  moveToTeamCoded?(botId: string, teamId: string, name: string): Promise<{ view: import("./team-move.mjs").TeamMoveView | null } | { refused: import("./team-move.mjs").TeamMoveRefusal }>;
  /** A team's own page: the bots its person has on My Cloud, and one moved in once they agree in main's own confirm. */
  teamBring?(): Promise<{ team?: { id: string; name: string; ready: boolean }; bots: Array<{ id: string; name: string; stays?: "default" | "chief" | "last" }> }>;
  teamBringMove?(botId: string): Promise<{ started: boolean; move: import("./team-move.mjs").TeamMoveView | null }>;
  teamBringStatus?(): Promise<import("./team-move.mjs").TeamMoveView | null>;
  teamRetry?(): Promise<import("./team-move.mjs").TeamMoveView | null>;
  /** Shows that team's page, where the bot now lives. */
  openTeam?(teamId: string): Promise<void>;
  /** On this computer's page: whether its bots can move to My Cloud now, and which are on their way. */
  botMoveState?(): Promise<BotMoveState>;
  /** The bots of this computer's a person can choose to move, asked on either page. */
  botChoices?(): Promise<{ bots: Array<{ id: string; name: string }> }>;
  /** Moves these bots to My Cloud; the others stay here and go on working. */
  moveBots?(ids: string[]): Promise<BotMoveState>;
  /** Moves everything to My Cloud: this computer's one-time move. */
  moveEverything?(): Promise<BotMoveState>;
  botMoveRetry?(): Promise<BotMoveView | null>;
  /** Shows My Cloud in this window. */
  openMyCloud?(): Promise<void>;
  /** The switch "Keep this computer's bots on this computer"; absent from an older desktop. */
  keepHere?(): Promise<KeepHereState>;
  /** Turns it (a real click on My Cloud's page). */
  setKeepHere?(on: boolean): Promise<KeepHereState>;
}

/** Some of this computer's bots moving to My Cloud (bot-move-main.mjs). `bot`: the first of them, `bots`: how many go. */
export interface BotMoveView { bot: { id: string; name: string }; team: { id: string; name: string }; phase: "moving" | "failed" | "done"; bots?: number }
export interface BotMoveState { available: boolean; moving: string[] }

/** The switch "Keep this computer's bots on this computer" (one-home-main.mjs). `shown`: this person has a Cloud of their
 * own the move applies to; `moved`: this computer's bots live on My Cloud, so turning it on brings them home; `coming`:
 * they are on their way, past turning back. */
export interface KeepHereState { shown: boolean; on: boolean; moved: boolean; coming: boolean }

export interface CloudSendSession {
  /** `timeoutMs`: how long this request may take, sized to the work it asks for. */
  call(method: string, route: string, body?: unknown, options?: { timeoutMs?: number }): Promise<{ status: number; ok: boolean; body: any }>;
  upload(route: string, bytes: Uint8Array, type: string): Promise<{ status: number; ok: boolean; body: any }>;
  /** The answer as it came, for a download; only the owner sessions main opens have it. */
  fetch?(route: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export class CloudSendError extends Error {
  code: string;
  /** Set when My Cloud refused with a `serverError.*` key: `message` is then My Cloud's own English for it. */
  errorKey?: string;
  errorParams?: Record<string, string | number>;
  constructor(code: string, message: string, options?: { cause?: unknown });
}
export function namedRefusal(answer: { status: number; body: any }): { message: string; errorKey: string; errorParams: Record<string, string | number> } | null;
export function unanswered(error: unknown): boolean;

export function botPatch(bot: Record<string, unknown>, parts: string[], cloudBots: ReadonlySet<string>): Record<string, unknown>;
export function parseSendState(value: unknown): { v: 1; clouds: Record<string, any> };
export function sendNotice(snapshot: CloudSendSnapshot): CloudSendNotice;

/** What a move's check found missing on My Cloud (cloud-send-check.mjs); `ok` when nothing is. */
export interface CloudMoveCheck {
  ok: boolean;
  gaps: {
    items: Array<{ key: string; kind: SendKind; label: string }>;
    parts: Array<{ key: string; label: string; parts: string[] }>;
    memory: Array<{ bot: string; path: string }>;
    rooms: Array<{ id: string; name: string }>;
    connections: string[];
    conversations: string[];
    /** Bot files by path, finished routine runs by id, bots whose journal rows, learned facts and teams whose pieces, and
     * conversations whose own settings My Cloud lacks. */
    files: string[];
    runs: string[];
    journal: string[];
    learned: string[];
    teams: string[];
    settings: string[];
  };
  /** Per conversation: rows My Cloud lacks, lines of its owner's it holds that do not carry the owner yet, and whether
   * this computer's visible path is My Cloud's ("equal"), appears in order inside a longer one ("inside", both sides added
   * to it) or does not hold ("broken"). */
  chats: Array<{ threadId: string; missing: number; unstamped: number; path: "equal" | "inside" | "broken" }>;
  attachments: string[];
  /** Credentials by id, compared by fingerprint only. */
  secrets: { equal: string[]; differs: string[]; missing: string[] };
}

export function createCloudSend(deps: {
  /** `timeoutMs`: how long a request that lists much may take on this computer's own server. */
  local(route: string, init?: { method?: string; timeoutMs?: number }): Promise<Response>;
  cloud: {
    origin(): string | null;
    asleep(): boolean;
    read(route: string): Promise<Response>;
    /** `move`: the move's session, which counts as someone using My Cloud. */
    open(options?: { move?: boolean }): Promise<CloudSendSession>;
  };
  handoff(what: { kind: string; [key: string]: unknown }): Promise<any>;
  /** Bring newer chats' copy, for a Cloud too old to take chats by row. */
  store: { read(): unknown; write(value: unknown): void };
  onChange?(snapshot: CloudSendSnapshot): void;
  t?(key: string, params?: Record<string, string | number>): string;
  now?(): number;
  /** How a check waits before it asks a slow Cloud again; setTimeout's by default. */
  sleep?(ms: number): Promise<void>;
  /** How long a move waits for a Cloud that does not answer: `stallMs` and `waits` in a check, `blips` in a pass. */
  patience?: { stallMs?: number; waits?: number[]; blips?: number[] };
  /** How long a move waits for My Cloud to run the engines whose keys it just took. */
  engineWaitMs?: number;
  /** My Cloud's plan disk and the Admin's grow, so a move makes room for the files it carries. */
  space?: { disk(): unknown; grow(sizeGb: number): Promise<unknown> };
  /** A move of this one bot into a team: its own things only, under the name the team gave it (read when it is added);
   * `label` names the person beside a file or bot of the same name. */
  team?: { bot: string; name: string; label: string } | null;
}): {
  snapshot(): CloudSendSnapshot;
  compare(): Promise<CloudSendSnapshot>;
  /** `reason: "move"`: everything this computer has, apps and keys first; `final`: the pass after this computer stopped,
   * which carries the sign-ins that refresh themselves and lets go of this computer's copies. */
  send(options?: { keys?: string[] | null; force?: string[]; reason?: string; final?: boolean }): Promise<CloudSendOutcome>;
  /** `scope`: only the bots a move of some of them carries. `stopped`: the person stopped the move, so a check waiting for My Cloud ends now. */
  check(options?: { scope?: string; stopped?(): boolean }): Promise<CloudMoveCheck>;
  /** Each automation a move carried ("routine:<id>", "call:<id>", "webhook:<id>", "app-event:<id>") and whether it was
   * on here when it went. */
  switches(): Record<string, boolean>;
  setItem(key: string, on: boolean): CloudSendSnapshot;
  dismiss(signature: string): CloudSendSnapshot;
  waiting(): { bots: number; total: number } | null;
};
