export type MoveFailurePhase = "copy" | "freeze" | "final" | "check" | "switch";
/**
 * Why a pass of the move failed: `rate_limited` (the Admin said too many requests, as for an owner session's pairing),
 * `unanswered` (no answer on the way to My Cloud: no network, a timeout, a 5xx), `session` (no owner session on My Cloud),
 * `local` (this computer's server didn't answer), `freeze` (this computer's server could not pause), `no_cloud`,
 * `unreachable` (My Cloud answered nothing usable), `refused` (My Cloud refused the pass), `incomplete` (the check still
 * found things missing after three passes), `not_ready` (My Cloud stopped being ready while this computer was frozen),
 * `other_account` (another account signed in mid-move), `switch_refused` (My Cloud didn't switch an automation on or finish
 * the move), `error` (anything else).
 */
export type MoveFailureCode = "rate_limited" | "unanswered" | "session" | "local" | "freeze" | "no_cloud" | "unreachable" | "refused" | "incomplete"
  | "not_ready" | "other_account" | "switch_refused" | "error";

export declare const FAILURE_PHASES: readonly MoveFailurePhase[];
export declare const FAILURE_CODES: readonly MoveFailureCode[];
export declare const SENTENCE_MAX: number;
export function rateLimited(error: unknown): boolean;
export function failureCode(error: unknown, phase: string): MoveFailureCode;
export function failureOf(error: unknown, phase: MoveFailurePhase, previous: unknown, at: number): { phase: MoveFailurePhase; code: MoveFailureCode; count: number; since: number; at: number };
export function safeSentence(value: unknown): string | null;
