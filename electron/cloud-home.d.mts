export type CloudMachineStatus = "provisioning" | "ready" | "stopped" | "payment-problem" | "failed";
export type CloudSetupStep = "reserving" | "storage" | "starting" | "checking";
/** What the renderer may know about the person's Cloud machine: never a code. */
export interface CloudMachine {
  status: CloudMachineStatus;
  origin?: string;
  /** While setting up, when the Admin says: the step it is at, and whether it is slow. */
  setup?: { step: CloudSetupStep; slow?: true };
  /** A failed setup's next automatic try, when the Admin says. */
  retryAt?: number;
  /** The volume now and the most the plan lets it grow to, when the Admin says. */
  disk?: { gb: number; maxGb: number };
}
/** A payment received but not yet linked to this account: nobody pays twice. */
export interface CloudPurchase { state: "confirming" | "held"; tier?: string; paidAt?: number }
export type CloudTrialState = "active" | "ending" | "processing" | "late" | "ended";
/** The free trial on the account's Cloud, as the Admin says: display only, never an entitlement. */
export interface CloudTrial {
  state: CloudTrialState;
  /** The plan on trial; a name newer than this app reads "Cloud". */
  tier?: string;
  /** When the trial ends and the first charge is due (ms). */
  endsAt: number;
  /** The first charge before tax, in US cents. */
  amount: number | null;
  /** When the first charge is taken (active, processing, late). */
  chargeAt: number | null;
  /** Processing or late: the Cloud runs without a payment until then. */
  holdUntil: number | null;
  /** Ending, late or ended: when its files are deleted if nobody subscribes. */
  deleteAt: number | null;
  /** What keeps it: nothing to do (`none`: renewing, or cancelled outright
   * before its end, when nothing can be bought until it has stopped), the
   * billing portal (`portal`: turn renewal back on, update the card) or a new
   * subscription (`checkout`, once it has ended). */
  keep: "none" | "portal" | "checkout";
  /** While it runs on a plan above Personal: Personal's price before tax, in US cents. */
  personalAmount?: number;
}
/** The trial's AI credit, in US dollars. */
export interface CloudCredit { grantedUsd: number; remainingUsd: number; state: "active" | "used_up" }
/** What a plan includes, as the Admin's catalog says. */
export interface CloudPlanAllowances {
  cpus: number; memoryMb: number;
  /** The disk it starts with, and the most it grows to (the same when it doesn't grow). */
  diskGb: number; maxDiskGb: number;
  /** Cloud computers at once, and cloud computer hours and voice characters a month. */
  computers: number; computerHours: number; voiceCharacters: number;
}
/** One plan OpenMausBot Cloud sells: its monthly price before tax in US cents,
 * and its free trial's days when it comes with one. */
export interface CloudOfferPlan { tier: string; label?: string; amount: number; allowances?: CloudPlanAllowances; trialDays?: number }
/** What someone may buy now: the session's `offer` (signed in), or the public
 * config (signed out). The trial's extras come only with a trial; money-back
 * only when the Admin offers it to this person. */
export interface CloudOffer {
  plans: CloudOfferPlan[];
  /** The plan preselected (a tier in `plans`). */
  recommended: string;
  creditUsd?: number;
  /** Days before a trial ends that its reminder email goes out, while the Admin sends one. */
  reminderDays?: number;
  refundDays?: number;
  /** Signed in: a checkout of theirs still open, and until when. */
  checkout?: { plan: string; openUntil: number };
}
export interface CloudHomeGrant { origin: string; code: string; expiresAt: number }
export interface CloudHomeTarget { origin: string; grant: CloudHomeGrant | null }
/** `largest`: the top plan, so nobody is pointed at a larger one. */
export interface CloudPlanDisk { maxBytes: number; volumeBytes?: number; startBytes?: number; largest?: true }
export interface RememberedCloudHome { accountId: string; origin: string }
export declare const CLOUD_HOME_NAME: string;
export declare const CLOUD_MACHINE_STATUSES: readonly CloudMachineStatus[];
export declare const CLOUD_MACHINE_CONNECTABLE: readonly CloudMachineStatus[];
export declare const CLOUD_SETUP_STEPS: readonly CloudSetupStep[];
export declare function parseCloudSummary(input: unknown): CloudMachine | null;
export declare function parseCloudPurchase(input: unknown): CloudPurchase | null;
export declare const CLOUD_TRIAL_STATES: readonly CloudTrialState[];
export declare function parseCloudTrial(input: unknown): CloudTrial | null;
export declare function parseCloudCredit(input: unknown): CloudCredit | null;
export declare function parseCloudOffer(input: unknown): CloudOffer | null;
export declare function parsePublicOffer(config: unknown): CloudOffer | null;
export declare function withoutTrial(offer: CloudOffer | null): CloudOffer | null;
export declare function cloudPlanDisk(state: unknown): CloudPlanDisk | null;
export declare function rememberedCloudHome(previous: RememberedCloudHome | null, state: unknown): RememberedCloudHome | null;
export declare function myCloudOrigin(known: {
  account: { homeTarget(): { origin: string } | null; state(): { account?: { id: string } } } | null;
  remembered: RememberedCloudHome | null;
  remoteAccess: unknown;
}): string | null;
export declare function isCloudHomeEntry(entry: { origin?: string } | null | undefined, known?: { homeOrigin?: string | null; remembered?: RememberedCloudHome | null }): boolean;
export declare function parsePairingGrant(input: unknown, origin: string, now: number): CloudHomeGrant | null;
export declare function withCloudHome<T extends { environments: Array<{ id: string; name: string; origin: string }>; activeId: string }>(state: T, machine: CloudMachine | null | undefined, makeId: () => string): T;
export declare function cloudHomeConnectUrl(target: CloudHomeTarget, now: number, open?: "phone" | null): string;
