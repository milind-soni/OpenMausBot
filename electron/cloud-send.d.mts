import type { PlanRow, SendKind } from "./cloud-send-parts.mjs";

export type CloudSendPlace = "none" | "asleep" | "unreachable" | "outdated" | "signed-out" | "local-unavailable" | "ready";

export interface CloudSendResult {
  /** Bots added to My Cloud, by name. */
  bots: string[];
  /** Bots My Cloud had, updated with what changed here. */
  updatedBots: string[];
  skills: number;
  logins: number;
  onePassword: boolean;
  /** "profile" and/or "language". */
  settings: string[];
  /** The chats My Cloud lacked, added by Bring newer chats; null when this send did not bring chats. */
  chats: { conversations: number; messages: number } | null;
  failed: Array<{ key: string; kind: SendKind | "chats"; label: string; error: string }>;
  /** model: kept My Cloud's engine; settings: a setting My Cloud refused; narrowed: a login kept to bots My Cloud lacks; memory: notes not copied. */
  notes: Array<{ kind: "model" | "settings" | "narrowed" | "memory"; bot?: string; login?: string }>;
}
/** `error`: the send failed as a whole (nothing after that point went), in words for the person. */
export interface CloudSendOutcome { at: number; reason: string; result: CloudSendResult; error?: string }
/** What did not go, grouped by reason (bots by name, logins only counted, at most three reasons), and `error`: why the
 * send stopped as a whole. */
export interface CloudSendFailure {
  reasons?: Array<{ what: { bots: string[]; skills: number; logins: number; onePassword: boolean; settings: number; chats: boolean }; error: string }>;
  error?: string;
}

export interface CloudSendSnapshot {
  cloud: CloudSendPlace;
  auto: boolean;
  running: null | { reason: string; progress?: { done: number; total: number }; phase?: "chats" };
  rows: PlanRow[];
  cloudOnly: Array<{ key: string; kind: SendKind; label: string; detail?: string; bot?: string }>;
  pending: number;
  signature: string;
  dismissed: string;
  last: CloudSendOutcome | null;
  cloudVersion: string | null;
  localVersion: string | null;
}

/** What My Cloud's own page is told: names of this computer's bots that wait, and counts, never logins' sites. */
export interface CloudSendNotice {
  ready: boolean;
  bots: string[];
  updatedBots: string[];
  skills: number;
  logins: number;
  onePassword: boolean;
  settings: number;
  signature: string;
  dismissed: boolean;
  running: boolean;
  last: ({ at: number; failed: number } & CloudSendFailure) | null;
}

export interface CloudSendBridge {
  state(): Promise<CloudSendSnapshot>;
  refresh(): Promise<CloudSendSnapshot>;
  send(options?: { keys?: string[]; force?: string[] }): Promise<CloudSendOutcome>;
  setAuto(on: boolean): Promise<CloudSendSnapshot>;
  setItem(key: string, on: boolean): Promise<CloudSendSnapshot>;
  onState(listener: (snapshot: CloudSendSnapshot) => void): () => void;
}
export interface CloudSendPageBridge {
  notice(): Promise<CloudSendNotice>;
  send(): Promise<CloudSendNotice>;
  dismiss(signature: string): Promise<CloudSendNotice>;
  onNotice(listener: (notice: CloudSendNotice) => void): () => void;
}

export interface CloudSendSession {
  call(method: string, route: string, body?: unknown): Promise<{ status: number; ok: boolean; body: any }>;
  upload(route: string, bytes: Uint8Array, type: string): Promise<{ status: number; ok: boolean; body: any }>;
  close(): Promise<void>;
}

export class CloudSendError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function botPatch(bot: Record<string, unknown>, parts: string[], cloudBots: ReadonlySet<string>): Record<string, unknown>;
export function parseSendState(value: unknown): { v: 1; auto: boolean; clouds: Record<string, unknown> };
export function sendNotice(snapshot: CloudSendSnapshot): CloudSendNotice;

export function createCloudSend(deps: {
  local(route: string): Promise<Response>;
  cloud: {
    origin(): string | null;
    asleep(): boolean;
    read(route: string): Promise<Response>;
    open(): Promise<CloudSendSession>;
  };
  handoff(what: { kind: "login"; id: string } | { kind: "1password" }): Promise<{ login?: Record<string, any>; onePassword?: { token: string; grants: Record<string, unknown> } }>;
  chats?: (() => Promise<{ conversations: number; messages: number }>) | null;
  store: { read(): unknown; write(value: unknown): void };
  onChange?(snapshot: CloudSendSnapshot): void;
  now?(): number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): {
  snapshot(): CloudSendSnapshot;
  compare(): Promise<CloudSendSnapshot>;
  send(options?: { keys?: string[] | null; force?: string[]; reason?: string }): Promise<CloudSendOutcome>;
  setAuto(on: boolean): CloudSendSnapshot;
  setItem(key: string, on: boolean): CloudSendSnapshot;
  dismiss(signature: string): CloudSendSnapshot;
  start(): void;
  stop(): void;
  waiting(): { bots: number; total: number } | null;
};

export const AUTO_SENDS_CHATS: boolean;
