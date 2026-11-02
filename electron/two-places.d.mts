/** A place this computer's bots could be brought together on. */
export interface TwoPlacesSuggestion { key: string; name: string; kind: "cloud" | "server" }
/** A place of the person's own besides this computer: `tell()` says where their other bots live, `bring()` (only where this
 * computer's bots could go now) is the one-time move there. */
export interface TwoPlacesPlace { key: string; name: string; kind: "cloud" | "server"; read(): Promise<unknown>; tell?(payload: unknown): Promise<unknown>; bring?(): Promise<unknown> }

export declare const LOOK_EVERY_MS: number;
export function usedBots(summary: unknown): string[];
export function parseDismissed(value: unknown): Set<string>;
export function createTwoPlaces(deps: {
  /** This computer's move summary, null once its bots moved. */
  local(): Promise<unknown>;
  /** What the person's other places call this computer, and telling it where their other bots live. */
  here?: { name(): Promise<string | null>; tell(payload: unknown): Promise<unknown> } | null;
  places(): TwoPlacesPlace[];
  settled(): boolean;
  /** A move is under way: nothing is read or told until it is done. */
  quiet?(): boolean;
  dismissed: { read(): unknown; write(value: unknown): void };
  onChange?(): void;
  now?(): number;
  log?(line: string): void;
}): TwoPlaces;
export interface TwoPlaces {
  state(): { suggest: TwoPlacesSuggestion | null };
  refresh(options?: { force?: boolean }): Promise<void>;
  bots(): { here: string[]; places: Record<string, string[]> };
  dismiss(key: string): { suggest: TwoPlacesSuggestion | null };
  accept(key: string): Promise<{ suggest: TwoPlacesSuggestion | null }>;
}
export function installTwoPlaces(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  guard(channel: string, handler: (...args: any[]) => unknown): (...args: any[]) => unknown;
  twoPlaces: TwoPlaces;
}): void;
