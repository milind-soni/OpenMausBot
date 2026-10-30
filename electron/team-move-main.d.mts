import type { TeamMoveView } from "./team-move.mjs";

export function moveTeams(state: unknown): Array<{ id: string; name: string; origin: string; ready: boolean }>;

export function installTeamMove(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  cloudPage(event: unknown): "local" | "cloud" | null;
  home(): { origin: string; grant(): Promise<{ origin: string; code: string }> } | null;
  account(): { state(): any; pairTeam(teamId: string): Promise<{ origin: string; code: string }> } | null;
  file(): string;
  journalFile(): string;
  openTeam?(team: { id: string; name: string }): void;
  onChange?(): void;
  fetch?: typeof fetch;
  journal?: { read(): unknown; write(value: unknown): void };
  log?(line: string): void;
}): {
  kick(): Promise<void>;
  view(): TeamMoveView | null;
  seen(): TeamMoveView | null;
  start(input: { bot: { id: string; name: string }; team: { id: string; name: string; origin?: string } }): Promise<void>;
  retry(): Promise<void>;
  close(): void;
  journal(): unknown;
};
