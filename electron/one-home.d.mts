/** The line either page shows for the one-time move to My Cloud (one-home.mjs). */
export type OneHomeView =
  /** `chats`: conversations gone of those to go; `failing`: it has failed for a day, with why; `updating`: My Cloud is too old
   * to take a move and updates first. */
  | { phase: "copy"; chats?: { done: number; total: number }; failing?: { error: string | null }; updating?: true }
  /** `waitingFor`: the bot or room whose work holds the move ("" when it has no name), and `waitingWhat` what it is;
   * neither while it waits for a quiet moment or has not asked yet. */
  | { phase: "wait"; waitingFor?: string; waitingWhat?: "bot" | "room" | "sign-in"; failing?: { error: string | null } }
  | { phase: "finishing"; failing?: { error: string | null } }
  /** What arrived, checked on both sides; `at`: when the move was done; `phone`: a phone was paired with this computer; `held`: keys a trial's Cloud keeps unused while its Claude credit lasts. */
  | { phase: "done"; at?: number; counts?: OneHomeCounts; phone: boolean; held: string[] }
  /** This computer's bots are on their way home from a My Cloud that goes on, because the person keeps them here;
   * `updating`: My Cloud is too old to stop their automations and updates first. */
  | { phase: "keeping"; updating?: true }
  /** My Cloud ended: this computer is home again; `back`: My Cloud's own changes came back too, unless `lost`; or, with
   * `elsewhere`, they came back to that other computer and this one keeps its own copy from `since`, with automations off.
   * `kept`: My Cloud goes on, and this computer's bots came home because the person keeps them here. */
  | { phase: "home-again" | "back"; lost?: true; elsewhere?: { name: string; since?: number }; kept?: true };
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
export function rateLimited(error: unknown): boolean;
/** Home is My Cloud by this journal. */
export function awayIn(journal: Record<string, any> | null | undefined): boolean;
export function parseKeep(value: unknown): { on: boolean };
/** This computer's bots are on their way home and past turning back. */
export function underWay(journal: Record<string, any> | null | undefined): boolean;
export function automationsOn(manifest: unknown): Record<string, boolean>;
export function keptSwitches(brought: Record<string, boolean>, there: Record<string, boolean> | null | undefined): Record<string, boolean>;
export function switchOn(key: string): { method: string; route: string; body: unknown } | null;
export function arrivedCounts(here: unknown, there: unknown): OneHomeCounts;

export function createOneHome(deps: {
  journal: { read(): unknown; write(value: unknown): void };
  cloud(): OneHomeCloud | null;
  send: { move(options?: { final?: boolean }): Promise<unknown>; check(): Promise<{ ok: boolean }>; switches(): Record<string, boolean>; snapshot(): any };
  local: {
    freeze(origin: string): Promise<{ frozen: true } | { busy: string; what?: string }>;
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
  /** The person's choice to keep this computer's bots here. */
  keep?: { read(): unknown; write(value: unknown): void };
  /** My Cloud's backup while it goes on, staged here first, then restored. */
  keepHome?: {
    stage(): Promise<{ staged: true; switches: Record<string, boolean> } | { deleted: true } | { later: number }>;
    bring(): Promise<{ restored: string; switches: Record<string, boolean> } | { deleted: true } | { later: number }>;
  };
  /** This computer's installation id; null while it can't be known. */
  installation?(): Promise<string | null>;
  /** Tells the Admin this computer's move is done; false when it can't take it yet. */
  reportMove?(): Promise<boolean>;
  /** Tells the Admin this computer keeps its bots here again; false when it can't take it yet. */
  reportKept?(): Promise<boolean>;
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
  /** A move or a send under way that restarting this app would cut into. */
  busy(): boolean;
  keeps(): boolean;
  /** Throws once this computer's bots are on their way home past turning back and `on` is false. */
  keep(on: boolean): Promise<void>;
  retry(): Promise<void>;
  seen(): OneHomeView | null;
  changed(): void;
  /** What the last run found holding the move that only a run finds out (move-status.mjs), and what kind of work holds
   * the freeze ("" when the server didn't say), never its name. */
  facts(): { noted: "waiting_quiet" | "thaw_failed" | "frozen_without_move" | "local_unavailable" | null; waiting: string | null };
  close(): void;
};
