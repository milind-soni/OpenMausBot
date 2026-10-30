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
  /** Apps and keys a move carried (MCP servers, AI keys, HighLevel, connected apps); 0 or absent for any other send. */
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
  teamRetry?(): Promise<import("./team-move.mjs").TeamMoveView | null>;
  /** Shows that team's page, where the bot now lives. */
  openTeam?(teamId: string): Promise<void>;
  /** The switch "Keep this computer's bots on this computer"; absent from an older desktop. */
  keepHere?(): Promise<KeepHereState>;
  /** Turns it (a real click on My Cloud's page). */
  setKeepHere?(on: boolean): Promise<KeepHereState>;
}

/** The switch "Keep this computer's bots on this computer" (one-home-main.mjs). `shown`: this person has a Cloud of their
 * own the move applies to; `moved`: this computer's bots live on My Cloud, so turning it on brings them home; `coming`:
 * they are on their way, past turning back. */
export interface KeepHereState { shown: boolean; on: boolean; moved: boolean; coming: boolean }

export interface CloudSendSession {
  call(method: string, route: string, body?: unknown): Promise<{ status: number; ok: boolean; body: any }>;
  upload(route: string, bytes: Uint8Array, type: string): Promise<{ status: number; ok: boolean; body: any }>;
  /** The answer as it came, for a download; only the owner sessions main opens have it. */
  fetch?(route: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export class CloudSendError extends Error {
  code: string;
  constructor(code: string, message: string, options?: { cause?: unknown });
}
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
  local(route: string, init?: { method?: string }): Promise<Response>;
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
  now?(): number;
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
  check(): Promise<CloudMoveCheck>;
  /** Each automation a move carried ("routine:<id>", "call:<id>", "webhook:<id>", "app-event:<id>") and whether it was
   * on here when it went. */
  switches(): Record<string, boolean>;
  setItem(key: string, on: boolean): CloudSendSnapshot;
  dismiss(signature: string): CloudSendSnapshot;
  waiting(): { bots: number; total: number } | null;
};
