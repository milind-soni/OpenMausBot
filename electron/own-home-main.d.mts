import type { OneHomeView } from "./one-home.mjs";

/** A server of the person's own as their bots' home, chosen once. */
export interface OwnHomeChoice { v: 1; id: string; origin: string; environmentId: string; name: string; at: number }
/** A saved place, as main keeps it (environments.cjs). */
export interface SavedPlace { id: string; kind: string; name: string; origin?: string; home?: true; team?: unknown; cloud?: unknown }
type Answer = { ok: boolean; status: number; body: any };

export declare const OWNER_KNOWN_MS: number;
export function parseChoice(value: unknown): OwnHomeChoice | null;
export function handSaved(entry: unknown): entry is SavedPlace & { kind: "remote"; origin: string };
export function serverRequests(place: { origin: string }, fetchImpl: typeof fetch): {
  request(method: string, route: string, init?: RequestInit): Promise<Response>;
  call(method: string, route: string, body?: unknown): Promise<Answer>;
  /** The server's word on this window's sign-in there. */
  who(): Promise<{ signedIn: boolean; own: boolean; environmentId: string | null; takesMove: boolean; status: number }>;
};
export function openServerSession(chosen: OwnHomeChoice, fetchImpl: typeof fetch): Promise<{
  call(method: string, route: string, body?: unknown): Promise<Answer>;
  upload(route: string, bytes: Uint8Array, type: string): Promise<Answer>;
  fetch(route: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}>;

export function installOwnHome(deps: {
  /** This computer's server, as its owner. */
  localRequest(route: string, init?: RequestInit): Promise<Response>;
  /** This window's own requests, with its sign-ins. */
  fetch: typeof fetch;
  environments(): SavedPlace[];
  /** This computer's server's private port, which hands a moving secret to main alone. */
  handoff(what: { kind: string; [key: string]: unknown }): Promise<any>;
  journal: { read(): unknown; write(value: unknown): void };
  choice: { read(): unknown; write(value: unknown): void };
  sendState: { read(): unknown; write(value: unknown): void };
  /** The move to My Cloud's journal. */
  cloudJournal(): unknown;
  lend?(projects: string[], place: SavedPlace | null): Promise<unknown>;
  phone?: { paired(): boolean; stop(): Promise<void>; start(): Promise<void> };
  openHome?(place: SavedPlace): void;
  lastInput?(): number;
  version?: string;
  onChange?(): void;
  now?(): number;
  log?(line: string): void;
}): {
  kick(): Promise<void>;
  view(): OneHomeView | null;
  seen(): OneHomeView | null;
  retry(): Promise<void>;
  busy(): boolean;
  away(): boolean;
  active(): boolean;
  origin(): string | null;
  underWay(): { phase: string; name: string } | null;
  home(): { id: string; origin: string; environmentId: string; name: string } | null;
  /** A server connected by hand whose fresh word is that it is this person's alone. */
  owns(place: unknown): boolean;
  offers(place: unknown): boolean;
  refresh(): void;
  start(id: string): Promise<{ started: true }>;
  close(): void;
  journal(): unknown;
  chosen(): OwnHomeChoice | null;
};
