export declare const CHROME_RAIL_WIDTH: number;
export declare const CHROME_RAIL_PATH: string;
export declare const RAIL_OFFER_GRACE_MS: number;
/** What a tour on the page beside the rail marks on it: its places, its ＋, or the whole rail shaded. */
export type RailMark = "places" | "add" | "dim";
export declare const RAIL_MARKS: readonly RailMark[];
/** What the page beside the window's rail knows of it: whether this window has one (two places or more) and whether the
 * person hid it. Never the places on it. */
export interface ChromeRailState { available: boolean; hidden: boolean }
/** `window.ogb.rail`. The page beside the rail offers the button that hides and shows it: `state()` from a document is
 * that offer, and main hides the rail only beside a document that made it. `mark` is this app's own page's (this
 * computer's, or My Cloud's as home): its tour marks a part of the rail, or clears the mark with null. `expand`, `onSkin`
 * and `onMark` are the rail's own page's, on this app's pages only. Each is absent on an older app. */
export interface ChromeRailBridge {
  state?(): Promise<ChromeRailState>;
  /** From the person's click. */
  setHidden?(hidden: boolean): Promise<ChromeRailState>;
  onState?(callback: (state: ChromeRailState) => void): () => void;
  mark?(part: RailMark | null): Promise<void>;
  expand?(on: boolean): Promise<void>;
  onSkin?(callback: (skin: string) => void): () => void;
  onMark?(callback: (part: string | null) => void): () => void;
}
export interface ChromeRail {
  attach(window: unknown): void;
  refresh(): void;
  expand(on: boolean): void;
  owns(event: unknown): boolean;
  shown(): boolean;
  expanded(): boolean;
  send(channel: string, ...values: unknown[]): void;
  install(ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void }): void;
}
export declare function createChromeRail(deps: {
  createView: (options: object) => any;
  preload: string;
  args: () => string[];
  url: () => string;
  wanted: () => boolean;
  prefs?: () => { railHidden(): boolean; setRailHidden(hidden: boolean): void } | null;
  changed?: () => void;
  trusted?: (event: unknown) => boolean;
  log?: (line: string) => void;
}): ChromeRail;
