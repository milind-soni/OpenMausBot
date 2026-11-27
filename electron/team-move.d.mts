/** Where a bot moving into a team comes from. */
export type TeamMoveSource = "cloud" | "computer";
/** Why a bot stays where it is, so its move stopped before anything changed. */
export type TeamMoveStays = "default" | "chief" | "last" | "elsewhere" | "gone";

/** A bot moving from My Cloud or this computer into a team, as the page of that place shows it. */
export interface TeamMoveView {
  /** The one moving now; with a batch, the one on its way, or the last. */
  bot: { id: string; name: string };
  team: { id: string; name: string };
  /** `failed`: it is still where it was, unchanged, and tries again by itself (or now, with Try again). With a batch: any
   * still on its way is `moving`, else any that failed is `failed`. */
  phase: "moving" | "failed" | "done";
  /** "computer": from this computer; absent: from My Cloud. */
  from?: "computer";
  /** Several bots chosen at once, in the order they move, each with how it went. */
  batch?: Array<{ id: string; name: string; phase: "moving" | "failed" | "done"; why?: TeamMoveStays }>;
}

export interface TeamMove {
  bot: { id: string; name: string };
  team: { id: string; name: string; origin?: string };
  /** "computer": this computer's bot; absent: My Cloud's. */
  from?: "computer";
  /** The bots chosen together share one. */
  batch?: string;
  /** Why it stopped before anything changed, when it stays where it is. */
  why?: TeamMoveStays;
  phase: "copy" | "freeze" | "final" | "check" | "switch" | "done";
  name?: string;
  label?: string;
  threadId?: string | null;
  held?: string[];
  teamDone?: true;
  failing?: true;
  stopped?: true;
  told?: true;
  thaw?: true;
  retryAt?: number;
  tries?: number;
  passes?: number;
  error?: string;
  startedAt: number;
  doneAt?: number;
}

export type TeamMoveRefusalCode = "notInTeam" | "notABot" | "movingElsewhere" | "computerMoving";
/** Why main would not start a bot's move: `code` and `params` for the page to say in its own language, `message` its
 * English for a code the page does not know. */
export interface TeamMoveRefusal {
  code: string;
  params: Record<string, string>;
  message: string;
}
export declare const TEAM_MOVE_TEXT: Readonly<Record<TeamMoveRefusalCode, (params: Record<string, string>) => string>>;
/** An Error whose `message` is the English, as an older page reads it. */
export function teamMoveRefusal(code: TeamMoveRefusalCode, params?: Record<string, string>): Error & { refusal: { code: TeamMoveRefusalCode; params: Record<string, string> } };

export function sourceOf(move: unknown): TeamMoveSource;
export const BATCH_MAX: number;
export const CHECK_PASSES: number;
export const RETRY_MS: number[];
export const BUSY_POLL_MS: number;
export function parseTeamMoves(value: unknown): { v: 1; moves: TeamMove[] };
export function routinesOn(held: unknown): string[];

export interface TeamMoveStart { bot: { id: string; name: string }; team: { id: string; name: string; origin?: string }; from?: "computer" }

export interface TeamMoveIo {
  engine: { move(options?: { final?: boolean }): Promise<unknown>; check(): Promise<{ ok: boolean }> };
  myCloud: { call(method: string, route: string, body?: unknown): Promise<{ ok: boolean; status: number; body: any }> };
  team: { begin(): Promise<{ name: string; done?: undefined } | { done: true; name?: string }>; done(on: string[]): Promise<void> };
  prepare?(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export function createTeamMove(deps: {
  journal: { read(): unknown; write(value: unknown): void };
  open(move: TeamMove): TeamMoveIo;
  inTeam(teamId: string): boolean;
  onChange?(view: TeamMoveView | null): void;
  now?(): number;
  timers?: { set(work: () => void, ms: number): unknown; clear(timer: unknown): void };
  log?(line: string): void;
}): {
  kick(): Promise<void>;
  view(from?: TeamMoveSource): TeamMoveView | null;
  start(input: TeamMoveStart): Promise<void>;
  startMany(inputs: TeamMoveStart[]): Promise<void>;
  retry(): Promise<void>;
  seen(from?: TeamMoveSource): TeamMoveView | null;
  moving(botId: string): TeamMove | null;
  close(): void;
};
