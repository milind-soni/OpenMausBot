export declare const SIGN_IN_START: string;
export declare const SIGN_IN_VERIFY: string;
export declare const SIGN_IN_TRIES: number;
export declare function cleanEmail(value: unknown): string | null;
export declare function cleanCode(value: unknown): string | null;
export declare function signInIdentity(input: { deviceName: unknown; platform: unknown; appVersion: unknown }): { deviceName: string; platform: string; appVersion: string } | null;
export declare function parseSignInStart(result: unknown): { attempt: string; expiresIn: number; resendAfter: number; signupOpen: boolean } | null;
export type CloudSignInStartFailure = "sso" | "rate-limited" | "browser" | "invalid-email" | "failed";
export type CloudSignInVerifyFailure = "wrong-code" | "expired" | "sso" | "two-factor" | "signup-closed" | "device-limit" | "rate-limited" | "browser" | "failed";
export declare function startFailure(error: unknown): CloudSignInStartFailure;
export declare function verifyFailure(error: unknown): CloudSignInVerifyFailure;
/** Why a new sign-in can't start now: `busy` (a moment), `signed-in`, `saved` (a saved sign-in this computer can't read or
 * remove; `reset` once clearing it is offered) or `connecting` (one in the browser is under way). */
export type CloudSignInBlockReason = "busy" | "signed-in" | "saved" | "connecting";
export interface CloudSignInBlocked { outcome: "blocked"; reason: CloudSignInBlockReason; reset?: true }
export declare function signInBlock(input: { closed: boolean; restoring: boolean; issued: unknown; grant: unknown; cleanupNeeded: boolean; connecting?: boolean }): CloudSignInBlockReason | null;
export declare const RESET_AFTER_TRIES: number;
export declare const RESET_AFTER_MS: number;
export declare const READ_WAIT_MS: number;
export declare function settledWithin(promise: Promise<unknown>, ms: number): Promise<void>;
export declare function resetOffered(input: { failures: number; since: number; now: number }): boolean;
export declare function failureKind(error: unknown): string;
export declare function retryAfterSeconds(headers: { get(name: string): string | null } | null | undefined, now?: number): number | undefined;
