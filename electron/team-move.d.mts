/** A bot moving from My Cloud into a team, as My Cloud's page shows it. */
export interface TeamMoveView {
  bot: { id: string; name: string };
  team: { id: string; name: string };
  /** `failed`: it is still on My Cloud, unchanged, and tries again by itself (or now, with Try again). */
  phase: "moving" | "failed" | "done";
}

export interface TeamMove {
  bot: { id: string; name: string };
  team: { id: string; name: string; origin?: string };
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

export const CHECK_PASSES: number;
export const RETRY_MS: number[];
export const BUSY_POLL_MS: number;
export function parseTeamMoves(value: unknown): { v: 1; moves: TeamMove[] };
export function routinesOn(held: unknown): string[];

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
  view(): TeamMoveView | null;
  start(input: { bot: { id: string; name: string }; team: { id: string; name: string; origin?: string } }): Promise<void>;
  retry(): Promise<void>;
  seen(): TeamMoveView | null;
  moving(botId: string): TeamMove | null;
  close(): void;
};
