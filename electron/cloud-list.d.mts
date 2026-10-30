export type CloudListStatus = "checkout" | "setting_up" | "ready" | "stopped" | "payment_problem" | "ended" | "offline";
/** The Admin's six colour swatches. */
export type CloudSwatch = "blue" | "green" | "amber" | "rose" | "violet" | "slate";
/** One Cloud of the verified session's `clouds` (contract v1), as this app reads it: never an address a page gave. */
export interface CloudListEntry {
  id: string;
  name: string;
  color: CloudSwatch | null;
  role: "owner" | "admin" | "member";
  tier: string | null;
  /** Where it runs: MausBot Cloud, or a server of the person's own. */
  runsOn: "cloud" | "server";
  status: CloudListStatus;
  origin: string | null;
  /** A Team or Business Cloud: the team behind its People. */
  teamId: string | null;
  /** The account's oldest open Cloud of its own: My Cloud. */
  primary: boolean;
  /** False for a server or computer of the person's own that signed in with their account (absent: MausBot runs or
   * manages it). */
  managed: boolean;
  /** While it is set up: the step it is at and how far along it is (0 to 1), when the Admin says. */
  setup?: { step?: import("./cloud-home.mjs").CloudSetupStep; progress?: number };
  /** When the Admin last heard from it (ms). */
  lastSeenAt?: number;
  /** The OpenMausBot version it runs, for an update reminder. */
  version?: string;
  /** Ended, stopped or with a payment problem, its files still kept: when they are deleted (ms). */
  deleteAfter?: number;
  /** Its owner may take it off their list (one of their own, in no team, that ended or was never paid for): the Admin's word. */
  removable?: true;
  /** A Ready Cloud whose plan sleeps: whether it is asleep now. */
  power?: import("./cloud-power.mjs").CloudPower;
}
/** What this app says of a listed Cloud it doesn't open: ended, its checkout not finished, a payment problem, or being set up. */
export type CloudState = "ended" | "checkout" | "payment" | "setup";
export declare function cloudState(cloud: Pick<CloudListEntry, "status"> | null | undefined): CloudState | null;
/**
 * The account's own plan's renewal, as the Admin says it for the account that pays (display only): a free trial (`trial`), its
 * renewal off (`cancelled`), when it renews (`renewsAt`) or, once cancelled, ends (`endsAt`; null: the end of the period paid
 * for), how many days its files are kept once it stops (`keptDays`, parts of a day allowed; null: not known), and a Team Cloud's
 * name (`team`), which stops for everyone in it.
 */
export interface CloudRenewal { trial: boolean; cancelled: boolean; renewsAt: number | null; endsAt: number | null; keptDays: number | null; team?: string }
export declare function parseCloudRenewal(clouds: unknown): (CloudRenewal & { cloudId: string }) | null;
/** Why an organization can't be added to the Team plan now. */
export type OrganizationBlock = "no_team_plan" | "limit" | "rate" | "off";
/** The session's `organizations`: the Team plan this account pays for, whether ＋ may add an organization to it now (else
 * why), and how many it has of how many. */
export interface CloudOrganizations { planCloudId: string; canAdd: boolean; blocked?: OrganizationBlock; count: number; max: number }
export declare const ORGANIZATION_BLOCKS: readonly OrganizationBlock[];
export declare function parseOrganizations(input: unknown): CloudOrganizations | null;
export declare const MAX_CLOUDS: number;
export declare const CLOUD_LIST_STATUSES: readonly CloudListStatus[];
export declare const CLOUD_SWATCH_COLORS: Readonly<Record<CloudSwatch, import("./cloud-buy.mjs").CloudColor | null>>;
export declare const CLOUD_SWATCHES: readonly CloudSwatch[];
export declare const CLOUD_ID: RegExp;
export declare const CLOUD_NAME_LIMIT: number;
export declare function cleanCloudListName(value: unknown): string | null;
export declare function ownCloud(cloud: CloudListEntry | null | undefined): boolean;
export declare function signedInServers(clouds: CloudListEntry[] | null | undefined): CloudListEntry[];
export declare function releaseVersion(value: unknown): string | null;
export declare function olderRelease(version: unknown, latest: unknown): boolean;
export declare function parseCloudList(input: unknown): CloudListEntry[] | null;
export declare function otherOwnClouds(clouds: CloudListEntry[] | null | undefined): CloudListEntry[];
export declare function cloudMachine(cloud: CloudListEntry | null | undefined): import("./cloud-home.mjs").CloudMachine | null;
export declare function stepProgress(step: unknown): number;
export declare function cloudSetupProgress(cloud: CloudListEntry | null | undefined): number | null;
export declare function swatchColor(swatch: unknown): import("./cloud-buy.mjs").CloudColor | null;
export declare function listedColors(clouds: CloudListEntry[] | null | undefined): Array<{ home?: true; teamId?: string; color: import("./cloud-buy.mjs").CloudColor | null }>;
export declare function ownCloudPlaces(clouds: CloudListEntry[] | null | undefined): Array<{ id: string; role: string; name: string; color: import("./cloud-buy.mjs").CloudColor | null; origin: string }>;
