import type { MoveFailureCode, MoveFailurePhase } from "./move-failure.mjs";

export type MovePhase = "none" | "copy" | "wait" | "freeze" | "final" | "check" | "switch" | "done" | "keeping" | "home-again" | "back";
/**
 * What holds the move now. Before any move starts (phase `none`, or `back` from an earlier one): `signed_out` (no MausBot
 * Cloud sign-in), `not_verified` (signed in, but the Admin's word on it isn't current: unreachable, expired or ended),
 * `team_only` (no Cloud of its own, only a team's), `no_cloud` (no Cloud of its own), `cloud_ended` (its Cloud ended and is
 * held until it is deleted), `moves_off` (the Admin doesn't let this account move: OMB_CLOUD_MOVES), `cloud_not_ready`
 * (setting up, stopped or failed: `cloudState` says which), `keep_here` ("Keep this computer's bots on this computer" is on),
 * `other_account` (this computer's move began for another account than the one signed in now), `frozen_without_move` (this
 * computer's server is frozen with no move under way, and is never lifted blindly), `local_unavailable` (this computer's
 * server didn't answer whether it is frozen). Once moved: `already_moved`. During a move: `cloud_outdated` (My Cloud is too
 * old to take a move and updates first), `thaw_failed` (a freeze could not be lifted yet), `retry_wait` (a pass failed and
 * goes again at `retryAt`), `waiting_quiet` (someone used this computer in the last 30 s), `waiting_busy` (work under way
 * here holds the freeze: `busy` says what kind), and the start reasons that can stop one under way.
 */
export type MoveReason = "signed_out" | "not_verified" | "no_cloud" | "team_only" | "cloud_not_ready" | "cloud_ended" | "moves_off" | "keep_here" | "other_account"
  | "frozen_without_move" | "local_unavailable" | "already_moved" | "cloud_outdated" | "thaw_failed" | "retry_wait" | "waiting_quiet" | "waiting_busy";

/** POST /api/cloud/desktop/move-status's body: epoch ms throughout, null for "not known" or "not now". */
export interface MoveStatusReport {
  v: 1;
  appVersion: string;
  phase: MovePhase;
  /** Null while the move goes on, or would start at the next run. */
  reason: MoveReason | null;
  keepHere: boolean;
  /** When the move entered this phase (a freeze that finds work under way stays in `wait`); null with phase `none`. */
  since: number | null;
  startedAt: number | null;
  /** The check's passes used, three at most. */
  passes: number | null;
  retryAt: number | null;
  /** With `waiting_busy`: the kind of work that holds the freeze, never its name. */
  busy: "bot" | "room" | "sign-in" | "other" | null;
  /** The Cloud's state as this app's session reads it ("ready", "provisioning", "stopped", …); null without a Cloud. */
  cloudState: string | null;
  /** The move's last failed pass, until it is done: where (null for a journal from before failures had codes), why, the
   * journal's sentence with names, quotes, paths, addresses and tokens taken out, how many and since when. */
  failure: { phase: MoveFailurePhase | null; code: MoveFailureCode; message: string | null; count: number; since: number | null; at: number | null } | null;
}

export declare const MOVE_STATUS_VERSION: 1;
export declare const MOVE_PHASES: readonly MovePhase[];
export declare const MOVE_REASONS: readonly MoveReason[];
export declare const MOVE_BUSY: readonly ("bot" | "room" | "sign-in" | "other")[];
export declare const MOVE_STATUS_HEARTBEAT_MS: number;
export declare const MOVE_STATUS_SETTLE_MS: number;
export declare const MOVE_STATUS_GAP_MS: number;
export declare const MOVE_STATUS_OFF_MS: number;

export function moveStatus(input: {
  journal: Record<string, any> | null;
  state: any;
  kept: boolean;
  facts?: { noted: string | null; waiting: string | null };
  now: number;
  version?: string;
}): MoveStatusReport;

export function createMoveStatusReport(deps: {
  status(): MoveStatusReport | null;
  /** True once the Admin recorded it; false when it doesn't take reports yet. */
  send(report: MoveStatusReport): Promise<boolean>;
  /** The sign-in reports go for (the Admin's device id); null while there is none. */
  signIn(): string | null;
  now?(): number;
  log?(line: string): void;
  timers?: { set(work: () => void, ms: number): unknown; clear(timer: unknown): void };
}): { changed(): void; flush(): Promise<void>; close(): void };
