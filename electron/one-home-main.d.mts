import type { installCloudSend } from "./cloud-send-main.mjs";
import type { OneHomeCloud, OneHomeView, createOneHome } from "./one-home.mjs";
import type { installTeamMove } from "./team-move-main.mjs";

export function oneHomeCloud(state: unknown): OneHomeCloud | null;
export function installationOf(environmentId: string): string;

type SendDeps = Parameters<typeof installCloudSend>[0];

export function installOneHome(deps: Omit<SendDeps, "local" | "move" | "moveSession"> & {
  /** This computer's server, as its owner. */
  localRequest(route: string, init?: RequestInit & { duplex?: "half" }): Promise<Response>;
  /** The MausBot Cloud sign-in (cloud-account.mjs). */
  account(): { state(): any; pairHome(): Promise<{ origin: string; code: string; expiresAt?: number }>; exportHome(options?: { installation?: string }): Promise<any>;
    reportMove?(options: { installation: string }): Promise<boolean>; pairTeam(teamId: string): Promise<{ origin: string; code: string; expiresAt?: number }> } | null;
  journalFile(): string;
  tempRoot(): string;
  lend?(projects: string[]): Promise<unknown>;
  phone?: { paired(): boolean; stop(): Promise<void>; start(): Promise<void> };
  openHome?(): void;
  openLocal?(): void;
  restart?(): void;
  version?: string;
  log?(line: string): void;
  journal?: { read(): unknown; write(value: unknown): void };
  /** Shows a team's page: where a bot moved there from My Cloud now lives. */
  openTeam?(team: { id: string; name: string }): void;
  /** The team moves' journal, team-moves.json beside journalFile by default. */
  teamJournal?: { read(): unknown; write(value: unknown): void };
}): ReturnType<typeof installCloudSend> & {
  kick(): Promise<void>;
  away(): boolean;
  view(): OneHomeView | null;
  close(): void;
  oneHome: ReturnType<typeof createOneHome>;
  journal(): unknown;
  marker(): Promise<{ frozen: boolean; cloud?: string; busy?: string }>;
  lastInput(): number;
  teamMove: ReturnType<typeof installTeamMove>;
};
