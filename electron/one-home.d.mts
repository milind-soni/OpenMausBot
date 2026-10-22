/** The line either page shows for the one-time move to My Cloud (one-home.mjs). */
/** Why the move fails: English, and the `serverError.*` key (with its values) My Cloud named it by, when it did. */
export interface OneHomeFailing { error: string | null; errorKey?: string; errorParams?: Record<string, string | number> }
export type OneHomeView =
  /** `chats`: conversations gone of those to go; `failing`: it has failed for a day, with why; `updating`: My Cloud is too old
   * to take a move and updates first. */
  | { phase: "copy"; chats?: { done: number; total: number }; failing?: OneHomeFailing; updating?: true }
  /** `waitingFor`: the bot or room still working here ("" when it has no name). */
  | { phase: "wait"; waitingFor?: string; failing?: OneHomeFailing }
  | { phase: "finishing"; failing?: OneHomeFailing }
  /** What arrived, checked on both sides; `at`: when the move was done; `phone`: a phone was paired with this computer; `held`: keys a trial's Cloud keeps unused while its Claude credit lasts. */
  | { phase: "done"; at?: number; counts?: OneHomeCounts; phone: boolean; held: string[] }
  /** My Cloud ended: this computer is home again; `back`: My Cloud's own changes came back too, unless `lost`; or, with
   * `elsewhere`, they came back to that other computer and this one keeps its own copy from `since`, with automations off. */
  | { phase: "home-again" | "back"; lost?: true; elsewhere?: { name: string; since?: number } };
export interface OneHomeCounts { bots: number; skills: number; logins: number; onePassword: boolean; chats: number; routines: number }

export interface OneHomeCloud {
  origin: string | null; account: string; machine: string | null; ready: boolean; moves: boolean; ended: boolean; paid: boolean;
  /** The computer an ended Cloud's things come home to, by installation (one-home-main.mjs `installationOf`). */
  homecoming?: { installationId: string; name: string };
  /** This app's sign-in (the Admin's device id), while connected. */
  signIn?: string;
}
type Answer = { ok: boolean; status: number; body: any };

export declare const QUIET_MS: number;
export declare const CHECK_PASSES: number;
export declare const FROZEN_RETRY_MS: number;
export declare const COPY_RETRY_MS: number[];
export declare const FAILING_LINE_MS: number;
export declare const KEPT_MS: number;
export function parseJournal(value: unknown): Record<string, any> | null;
export function switchOn(key: string): { method: string; route: string; body: unknown } | null;
export function arrivedCounts(here: unknown, there: unknown): OneHomeCounts;

export function createOneHome(deps: {
  journal: { read(): unknown; write(value: unknown): void };
  cloud(): OneHomeCloud | null;
  send: { move(options?: { final?: boolean }): Promise<unknown>; check(): Promise<{ ok: boolean }>; switches(): Record<string, boolean>; snapshot(): any };
  local: {
    freeze(origin: string): Promise<{ frozen: true } | { busy: string }>;
    unfreeze(options?: { automations?: "off" }): Promise<void>;
    frozen(): Promise<boolean>;
    json(route: string): Promise<any>;
    call(method: string, route: string, body?: unknown): Promise<Answer>;
    forget?(): Promise<void>;
  };
  session(): Promise<{ call(method: string, route: string, body?: unknown): Promise<Answer>; close(): Promise<void> }>;
  /** My Cloud's session is no longer needed: the move is done, paused, or not this account's. */
  release?(): Promise<void>;
  lend?(projects: string[]): Promise<unknown>;
  phone?: { paired(): boolean; stop(): Promise<void>; start(): Promise<void> };
  openHome?(): void;
  openLocal?(): void;
  lastInput?(): number;
  again?: { bring(): Promise<{ restored: string; switches: Record<string, boolean> } | { deleted: true } | { later: number }> };
  /** This computer's installation id; null while it can't be known. */
  installation?(): Promise<string | null>;
  /** Tells the Admin this computer's move is done; false when it can't take it yet. */
  reportMove?(): Promise<boolean>;
  restart?(): void;
  version?: string;
  onChange?(view: OneHomeView | null): void;
  now?(): number;
  timers?: { set(work: () => void, ms: number): unknown; clear(timer: unknown): void };
  log?(line: string): void;
}): {
  kick(): Promise<void>;
  view(): OneHomeView | null;
  away(): boolean;
  retry(): Promise<void>;
  seen(): OneHomeView | null;
  changed(): void;
  close(): void;
};
