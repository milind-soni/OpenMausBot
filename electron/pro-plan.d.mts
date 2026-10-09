import type { CloudAccountState } from "./cloud-account.mjs";

/** "1": the server's person counts as Pro. The desktop app sets it ("1" or
 * "0") on the server it starts; any other server says Pro with OMB_PRO_PLAN=1. */
export declare const PRO_PLAN_ENV: "OMB_PRO_PLAN";
export declare const PRO_PLAN_MESSAGE: "openmausbot:pro-plan";
export interface ProPlanMessage { type: typeof PRO_PLAN_MESSAGE; pro: boolean }

export declare function liveCallsAllowed(input?: {
  /** The Cloud sign-in's state; omitted where it is never seen (the server). */
  account?: CloudAccountState | null;
  /** The answer this side last had, for a state that cannot say. */
  lastKnown?: boolean;
  /** This server is an OMB Cloud home. */
  cloudHome?: boolean;
}): boolean;
export declare function proPlanEnvironment(pro: boolean): { OMB_PRO_PLAN: "1" | "0" };
export declare function proPlanFromEnvironment(env: Record<string, string | undefined> | undefined): boolean;
export declare function proPlanMessage(pro: boolean): ProPlanMessage;
export declare function proPlanFromMessage(message: unknown): boolean | null;

export interface ProPlanRelay {
  /** The answer after this sign-in state; a state that cannot say keeps the last one. */
  update(account: CloudAccountState | null | undefined): boolean;
  environment(): { OMB_PRO_PLAN: "1" | "0" };
  message(): ProPlanMessage;
}
export declare function createProPlanRelay(): ProPlanRelay;
