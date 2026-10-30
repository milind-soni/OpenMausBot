/** A place this computer's bots could be brought together on. */
export interface TwoPlacesSuggestion { key: string; name: string; kind: "cloud" | "server" }
export interface TwoPlacesPlace { key: string; name: string; kind: "cloud" | "server"; read(): Promise<unknown>; bring(): Promise<unknown> }

export declare const LOOK_EVERY_MS: number;
export function usedBots(summary: unknown): string[];
export function parseDismissed(value: unknown): Set<string>;
export function createTwoPlaces(deps: {
  local(): Promise<unknown>;
  places(): TwoPlacesPlace[];
  settled(): boolean;
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
