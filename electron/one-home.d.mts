/** The line either page shows for the one-time move to My Cloud (one-home.mjs), or to a server of the person's own, named
 * `place`. */
export type OneHomeView = OneHomePhase & { place?: string };
/** Something a move could not carry, by its name, and why. */
export type OneHomeNotCarried = { label: string; error: string };
/** Why the move fails, including the server's error code and parameters when provided. */
export type OneHomeFailing = { error: string | null; errorKey?: string; errorParams?: Record<string, string | number>; items?: OneHomeNotCarried[] };
/** How far the check of what arrived is. */
export type OneHomeChecking = { step: "manifest" | "files" | "chats" | "attachments" | "credentials" | (string & {}); done: number; total: number; bots: number };
/** My Cloud did not answer, and is asked again at `until`. */
export type OneHomeSlow = { until: number };
/** Another computer moves into the same Cloud now, by its name ("" when it gave none): this one waits for it. */
export type OneHomeQueued = { name: string };
/** A connector that stayed on this computer. */
export type OneHomeStayed = { name: string; needs?: string };
type OneHomePhase =
  /** `chats`: conversations gone of those to go; `failing`: it has failed for a day, or its check found things missing pass
   * after pass, with why and what did not go; `updating`: My Cloud is too old
   * to take a move and updates first. */
  | { phase: "copy"; chats?: { done: number; total: number }; failing?: OneHomeFailing; updating?: true; slow?: OneHomeSlow; queued?: OneHomeQueued }
  /** `waitingFor`: the bot or room whose work holds the move ("" when it has no name), and `waitingWhat` what it is;
   * neither while it waits for a quiet moment or has not asked yet. */
  | { phase: "wait"; waitingFor?: string; waitingWhat?: "bot" | "room" | "sign-in"; failing?: OneHomeFailing; queued?: OneHomeQueued }
  /** `checking`: the check of what arrived, at its step (`manifest`, `files`, `chats`, `attachments`, `credentials`), with
   * `done` of `total` there and how many bots it checks. */
  | { phase: "finishing"; checking?: OneHomeChecking; slow?: OneHomeSlow; failing?: OneHomeFailing }
  /** No move has started: the person is asked which bots go. */
  | { phase: "choose" }
  /** What arrived, checked on both sides; `at`: when the move was done; `phone`: a phone was paired with this computer; `held`: keys a trial's Cloud keeps unused while its Claude credit lasts; `left`: what My Cloud refused for good, which stayed where it was; `stayed`: connectors that work only on this computer (`needs`: a program My Cloud lacks). */
  | { phase: "done"; at?: number; counts?: OneHomeCounts; phone: boolean; held: string[]; left?: OneHomeNotCarried[]; stayed?: OneHomeStayed[] }
  /** This computer's bots are on their way home from a My Cloud that goes on, because the person keeps them here;
   * `updating`: My Cloud is too old to stop their automations and updates first. */
  | { phase: "keeping"; updating?: true }
  /** My Cloud ended: this computer is home again; `back`: My Cloud's own changes came back too, unless `lost`; or, with
   * `elsewhere`, they came back to that other computer and this one keeps its own copy from `since`, with automations off.
   * `kept`: My Cloud goes on, and this computer's bots came home because the person keeps them here. `gone`: the Cloud this
   * computer moved to was deleted, or ended while another Cloud is My Cloud; its own copy is open as it was at the move, with
   * every automation off. */
  | { phase: "home-again" | "back"; lost?: true; elsewhere?: { name: string; since?: number }; kept?: true; gone?: true };
export interface OneHomeCounts { bots: number; skills: number; logins: number; onePassword: boolean; chats: number; routines: number }

export interface OneHomeCloud {
  origin: string | null; account: string; machine: string | null; ready: boolean; moves: boolean; ended: boolean; paid: boolean;
  /** A server of the person's own, by the name they know it by: the move's line and the frozen copy say it. */
  name?: string;
  /** The computer an ended Cloud's things come home to, by installation (one-home-main.mjs `installationOf`). */
  homecoming?: { installationId: string; name: string };
  /** This app's sign-in (the Admin's device id), while connected. */
  signIn?: string;
  /** The Admin answered this sign-in just now (connected), so its word on the person's Clouds counts. */
  verified?: boolean;
  /** Its id in the session's list of Clouds, which the journal keeps, so the Cloud is known again at a new address. */
  id?: string;
  /** The addresses it answered at before it moved to another provider: a journal kept at one of them is this Cloud's. */
  formerOrigins?: string[];
}
type Answer = { ok: boolean; status: number; body: any };

export declare const QUIET_MS: number;
export declare const CHECK_PASSES: number;
export declare const FROZEN_RETRY_MS: number;
export declare const COPY_RETRY_MS: number[];
export declare const CHECK_RESUME_MS: number;
export declare const QUEUE_POLL_MS: number;
export declare const FAILING_LINE_MS: number;
export declare const KEPT_MS: number;
export function parseJournal(value: unknown): Record<string, any> | null;
export function rateLimited(error: unknown): boolean;
/** Home is My Cloud by this journal. */
export function awayIn(journal: Record<string, any> | null | undefined): boolean;
/** `cloud` is the Cloud kept as `kept`: the same address, the same id, or one of its former addresses. */
export function sameCloud(cloud: { origin: string | null; id?: string | null; formerOrigins?: string[] }, kept: { origin: string; id?: string }): boolean;
export function parseKeep(value: unknown): { on: boolean };
/** This computer's bots are on their way home and past turning back. */
export function underWay(journal: Record<string, any> | null | undefined): boolean;
export function automationsOn(manifest: unknown): Record<string, boolean>;
export function keptSwitches(brought: Record<string, boolean>, there: Record<string, boolean> | null | undefined): Record<string, boolean>;
export function switchOn(key: string): { method: string; route: string; body: unknown } | null;
export function arrivedCounts(here: unknown, there: unknown): OneHomeCounts;
export function missingOf(report: unknown): string;

export function createOneHome(deps: {
  journal: { read(): unknown; write(value: unknown): void };
  cloud(): OneHomeCloud | null;
  send: { move(options?: { final?: boolean; files?: boolean }): Promise<unknown>; check(options?: { stopped?(): boolean }): Promise<{ ok: boolean }>; switches(): Record<string, boolean>; snapshot(): any };
  local: {
    freeze(origin: string): Promise<{ frozen: true } | { busy: string; what?: string }>;
    unfreeze(options?: { automations?: "off" }): Promise<void>;
    frozen(): Promise<boolean>;
    json(route: string): Promise<any>;
    call(method: string, route: string, body?: unknown): Promise<Answer>;
    forget?(): Promise<void>;
    /** This computer's freeze marker: the Cloud it names (`cloud`), or the server of the person's own (`place`). */
    marker?(): Promise<{ frozen: boolean; cloud?: string; place?: string }>;
  };
  /** The Admin's word that this account's Cloud at `origin` is gone: deleted, or ended (stopped and kept only until it is
   * deleted); null for anything else, and while it can't be asked. */
  gone?(origin: string): Promise<"deleted" | "ended" | null>;
  session(): Promise<{ call(method: string, route: string, body?: unknown): Promise<Answer>; close(): Promise<void> }>;
  /** My Cloud's session is no longer needed: the move is done, paused, or not this account's. */
  release?(): Promise<void>;
  /** One computer at a time runs the heavy part of a move into My Cloud: `take()` is null once this one does, else who does. */
  lease?: { take(): Promise<null | { name: string }>; release(): Promise<void> };
  /** True while no first move should start, as the person is asked which bots go. */
  choosing?(): Promise<boolean>;
  lend?(projects: string[]): Promise<unknown>;
  phone?: { paired(): boolean; stop(): Promise<void>; start(): Promise<void> };
  openHome?(): void;
  openLocal?(): void;
  lastInput?(): number;
  /** Whether this computer's own copy, the server on its own data folder, is the one answering now: while it isn't, no first
   * move starts and no top-up goes. */
  ownCopy?(): boolean;
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
  t?(key: string, params?: Record<string, string | number>): string;
}): {
  kick(): Promise<void>;
  view(): OneHomeView | null;
  away(): boolean;
  /** A move or a send under way that restarting this app would cut into. */
  busy(): boolean;
  /** The move of the account signed in is past where it can stop by itself: that account can't be left for a moment. */
  moving(): boolean;
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
