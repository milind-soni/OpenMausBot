export { createCloudPowerGate, openSleepingCloud } from "./cloud-power.mjs";
export type CloudMachineStatus = "provisioning" | "ready" | "stopped" | "payment-problem" | "failed";
export type CloudSetupStep = "reserving" | "storage" | "starting" | "checking";
export type CloudUnreachableCause = "host" | "no_answer";
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
  /** Ready, but the Admin's health checks can't reach it: its server is being restarted by the hosting provider (`host`), or it stopped answering. */
  unreachable?: { cause: CloudUnreachableCause; since: number };
  /** Only for a plan that sleeps when idle: whether it is awake now, as the Admin says. */
  power?: import("./cloud-power.mjs").CloudPower;
  /** The Admin lets this account's computer move to it now (its `moves` gate). */
  moves?: true;
  /** It ended (a trial not paid, a plan cancelled) and the Admin still holds it until it is deleted. `homecoming`: the one
   * computer its things come home to (its installation id and name), among those whose move is done; every other computer
   * keeps its own copy. Absent while none can be chosen: every computer comes home. */
  hold?: { until: number; homecoming?: { installationId: string; name: string } };
}
/** A payment received but not yet linked to this account: nobody pays twice. */
export interface CloudPurchase { state: "confirming" | "held"; tier?: string; paidAt?: number }
export type CloudTrialState = "active" | "ending" | "processing" | "late" | "ended";
/** The plans this app knows by name. */
export type CloudPlanTier = "starter" | "personal" | "pro" | "max";
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
  /** While it runs on a plan above Personal and Personal is the way down: Personal's price before tax, in US cents. An
   * older Admin's only word for the way down; `switchTo` wins over it. */
  personalAmount?: number;
  /** The plan this trial can switch to from its Plan page, and its price before tax in US cents, only while a switch is
   * the way down. */
  switchTo?: { tier: CloudPlanTier; amount: number };
}
/** The trial's AI credit, in US dollars. */
export interface CloudCredit { grantedUsd: number; remainingUsd: number; state: "active" | "used_up" }
/** One allowance of the plan: `used` of `max` this month in its own unit (hours, characters, calls, US dollars; GB for
 * `storage`, the one that isn't monthly). `usedUp`: none left, whichever limit was reached. */
export type CloudUsageKind = "computerHours" | "voice" | "decisions" | "x" | "research" | "storage";
export interface CloudUsageMeter { kind: CloudUsageKind; used: number; max: number; usedUp?: true }
/** The plan's allowances and their use (the session's `cloud.usage`): display only. `resetsAt`: when the monthly ones start
 * over; `trialEndsAt`: a free trial's share until its first payment; `upgrades`: the bigger plans the app can move to
 * itself now, cheapest first (empty: none, so Upgrade opens the Cloud page). */
export interface CloudUsage {
  tier: string; resetsAt: number; trialEndsAt?: number; meters: CloudUsageMeter[];
  upgrades: { tier: "starter" | "personal" | "pro" | "max"; amount: number }[];
}
/** What a plan includes, as the Admin's catalog says. */
export interface CloudPlanAllowances {
  cpus: number; memoryMb: number;
  /** The kind of CPUs, when the Admin says. */
  cpuKind?: "shared" | "performance";
  /** The disk it starts with, and the most it grows to (the same when it doesn't grow). */
  diskGb: number; maxDiskGb: number;
  /** Cloud computers at once, and cloud computer hours and voice characters a month. */
  computers: number; computerHours: number; voiceCharacters: number;
  /** It sleeps when idle and wakes when someone or a schedule needs it. */
  sleeps?: true;
  /** Swap on its machine, when the Admin says and it has some. */
  swapMb?: number;
  /** How many days its daily backups are kept, when the Admin says. */
  snapshotDays?: number;
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
export declare const CLOUD_UNREACHABLE_CAUSES: readonly CloudUnreachableCause[];
export declare const INSTALLATION_ID: RegExp;
export declare function parseCloudPower(input: unknown): import("./cloud-power.mjs").CloudPower | null;
export declare function parseCloudSummary(input: unknown): CloudMachine | null;
export type CloudTeamRole = "owner" | "admin" | "member";
/** A team this account is in, from the verified session: its Cloud as the Admin describes it, null while it has none. */
export interface CloudTeam { id: string; name: string; role: CloudTeamRole; machine: CloudMachine | null }
export declare const CLOUD_TEAM_ROLES: readonly CloudTeamRole[];
/** owner → Super admin, admin → Admin, member → User. */
export declare function teamRoleLabel(role: string | null | undefined): "Super admin" | "Admin" | "User";
export declare function parseCloudTeams(input: unknown): CloudTeam[];
export declare function cloudUnreachableText(state: unknown, origin?: string | null): string | null;
export declare function parseCloudPurchase(input: unknown): CloudPurchase | null;
export declare const CLOUD_TRIAL_STATES: readonly CloudTrialState[];
export declare function parseCloudTrial(input: unknown): CloudTrial | null;
export declare function parseCloudCredit(input: unknown): CloudCredit | null;
export declare const CLOUD_USAGE_KINDS: readonly CloudUsageKind[];
export declare function parseCloudUsage(input: unknown): CloudUsage | null;
export declare function parseCloudOffer(input: unknown): CloudOffer | null;
export declare function parsePublicOffer(config: unknown): CloudOffer | null;
export declare function withoutTrial(offer: CloudOffer | null): CloudOffer | null;
export declare function cloudPlanDisk(state: unknown): CloudPlanDisk | null;
export declare function readyCloudOrigin(state: unknown): string | null;
export declare function machineSetup(machine: CloudMachine | null | undefined): { step?: CloudSetupStep; slow?: true } | null;
export declare function cloudSetupOf(state: unknown): { step?: CloudSetupStep; slow?: true } | null;
export declare function rememberedCloudHome(previous: RememberedCloudHome | null, state: unknown): RememberedCloudHome | null;
export declare function signInCloudSession(input: {
  origin: string | null; mine: string | null; pair: () => Promise<{ origin: string; code: string }>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<boolean>;
export declare function myCloudOrigin(known: {
  account: { homeTarget(): { origin: string } | null; state(): { account?: { id: string } } } | null;
  remembered: RememberedCloudHome | null;
  remoteAccess: unknown;
}): string | null;
export declare function isCloudHomeEntry(entry: { origin?: string } | null | undefined, known?: { homeOrigin?: string | null; remembered?: RememberedCloudHome | null }): boolean;
export declare function parsePairingGrant(input: unknown, origin: string, now: number): CloudHomeGrant | null;
export declare function withCloudHome<T extends { environments: Array<{ id: string; name: string; origin: string; color?: string; home?: true }>; activeId: string }>(state: T, machine: CloudMachine | null | undefined, makeId: () => string, look?: { name?: string | null; color?: string | null } | null): T;
export declare function cloudHomeConnectUrl(target: CloudHomeTarget, now: number, open?: "phone" | null, route?: string | null): string;
export declare function cloudPageSenderAllowed(event: unknown, context: { contents: unknown; homeOrigin: string | null; activeOrigin: string | null | undefined }): boolean;
