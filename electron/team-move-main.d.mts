import type { TeamMoveSource, TeamMoveStart, TeamMoveView } from "./team-move.mjs";

export function moveTeams(state: unknown): Array<{ id: string; name: string; origin: string; ready: boolean }>;

export function teamMoveConfirmWords(names: { bot: string; team: string }, t?: (key: string, params?: Record<string, string | number>) => string,
  options?: { from?: TeamMoveSource; bots?: string[] | null }): { message: string; detail: string; buttons: string[] };
export function bringableBots(listed: unknown): Array<{ id: string; name: string; stays?: "default" | "chief" | "last" }>;
export function computerStays(listed: unknown, botId: string, teamId: string | null): "default" | "chief" | "elsewhere" | "last" | null;

export function installTeamMove(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  cloudPage(event: unknown): "local" | "cloud" | null;
  pageOrigin?(event: unknown): string | null;
  confirmMove?(words: { message: string; detail: string; buttons: string[] }): Promise<boolean>;
  home(): { origin: string; grant(): Promise<{ origin: string; code: string }> } | null;
  computer?: { request(route: string, init?: RequestInit): Promise<Response>; available(): boolean; busy?(botId: string): boolean } | null;
  account(): { state(): any; pairTeam(teamId: string): Promise<{ origin: string; code: string }> } | null;
  file(): string;
  journalFile(): string;
  openTeam?(team: { id: string; name: string }): void;
  onChange?(): void;
  fetch?: typeof fetch;
  journal?: { read(): unknown; write(value: unknown): void };
  log?(line: string): void;
  t?(key: string, params?: Record<string, string | number>): string;
}): {
  kick(): Promise<void>;
  view(from?: TeamMoveSource): TeamMoveView | null;
  seen(from?: TeamMoveSource): TeamMoveView | null;
  start(input: TeamMoveStart): Promise<void>;
  startMany(inputs: TeamMoveStart[]): Promise<void>;
  retry(): Promise<void>;
  close(): void;
  journal(): unknown;
  moving(botId: string): boolean;
};
