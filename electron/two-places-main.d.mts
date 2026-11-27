import type { TwoPlaces } from "./two-places.mjs";

export function installTwoPlacesMain(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  /** This computer's own page only. */
  guard(channel: string, handler: (...args: any[]) => unknown): (...args: any[]) => unknown;
  localRequest(route: string, init?: RequestInit): Promise<Response>;
  fetch: typeof fetch;
  environments(): any[];
  t?(key: string, params?: Record<string, string | number>): string;
  /** My Cloud's address while it is ready, and whether it sleeps now. */
  cloud(): { origin: string | null; asleep: boolean };
  oneHome: { journal(): unknown; keep: { state(): { shown: boolean; on: boolean; moved: boolean }; set(on: boolean): Promise<unknown> } };
  ownHome: { owns(place: any): boolean; offers(place: any): boolean; start(id: string): Promise<unknown>; active(): boolean; away(): boolean; refresh(): void };
  dismissed: { read(): unknown; write(value: unknown): void };
  /** Each own place's bots as last read, kept across restarts. */
  lastRead?: { read(): unknown; write(value: unknown): void } | null;
  /** The verified account, whose state lists the person's teams; with `teamsRemembered`, each team is a place read for its bots. */
  account?: () => ({ state(): any } | null);
  teamsRemembered?: { read(): unknown; write(value: unknown): void };
  /** "This computer and My Cloud together" is on: My Cloud is never suggested. */
  together?(): boolean;
  /** The Admin answered just now that My Cloud is awake: only then is it read or told. */
  awakeNow?(): Promise<boolean>;
  tell(): void;
  log?(line: string): void;
}): TwoPlaces & { close(): void };
