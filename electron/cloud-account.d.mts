export interface CloudAccountState {
  status: "signed-out" | "connecting" | "connected" | "reauth-required" | "unavailable";
  message?: string;
  enrollment?: { userCode: string; expiresAt: number };
  account?: { id: string; email: string };
  deviceId?: string;
  expiresAt?: number;
  /** Only a current server-verified session can include an entitlement
   * (verified within the last few minutes; a failed re-check keeps it).
   * `plan` "pro" means any paid plan; `tier` names it ("personal", "pro",
   * "max", or one newer than this app) when the Admin sends one. */
  entitlement?: { plan: "free" | "pro"; tier?: string; status: "active" | "inactive"; expiresAt: number | null; version: number };
  verifiedAt?: number;
  verifiedUntil?: number;
  /** Connected, but the last checks with OMB Cloud failed; the snapshot is the last verified one. */
  checking?: true;
  /** Not connected (unavailable, or the sign-in ended): the paid plan last
   * verified for this account, for display only. It activates nothing. */
  lastPlan?: { tier?: string; active: boolean };
  /** The person's Cloud home machine, when their plan has one. */
  machine?: import("./cloud-home.mjs").CloudMachine;
  /** A payment OMB Cloud received and is still linking to this account. */
  purchase?: import("./cloud-home.mjs").CloudPurchase;
  /** Connected: the free trial on this account's Cloud, when the Admin says (display only). */
  trial?: import("./cloud-home.mjs").CloudTrial;
  /** Connected: the trial's Claude credit, while it lasts. */
  credit?: import("./cloud-home.mjs").CloudCredit;
  /** Connected: what this account may buy now (the session's `offer`), for wording only. */
  offer?: import("./cloud-home.mjs").CloudOffer;
  /** A checkout this app opened (or a sign-in it started on the way to
   * one: `signIn`) in the last 24 hours: the plan, and when (Reopen checkout
   * starts the 30-minute watch again). `link`: main keeps its page, so Reopen
   * and Copy link use that same page. */
  checkout?: { plan: string; startedAt: number; signIn?: true; link?: true; done?: true };
  /** This app talks to the staging Admin (OMB_CLOUD_STAGING=1): test payments, test Clouds. */
  staging?: true;
}
/** The email-code sign-in (cloud-signin.mjs). `sent`: the code is on its
 * way (`resendAt`: when another may be asked for). `browser`: this Cloud signs
 * in only in the browser (single sign-on there, or an older Admin). */
export type CloudSignInStart =
  | { outcome: "sent"; email: string; expiresAt: number; resendAt: number; /** False: new accounts are closed, so only an existing one gets a code. */ signupOpen: boolean }
  | { outcome: import("./cloud-signin.mjs").CloudSignInStartFailure };
/** `signed-in`: stored and read like the browser sign-in; `wrong-code` says
 * the tries left; `expired` needs a new code. */
export type CloudSignInVerify =
  | { outcome: "signed-in"; state: CloudAccountState }
  | { outcome: "wrong-code"; triesLeft: number }
  | { outcome: Exclude<import("./cloud-signin.mjs").CloudSignInVerifyFailure, "wrong-code"> };
/** How the Cloud is shown in this app's switcher and Settings → Servers. */
export interface CloudHomeLook { name: string; color: import("./cloud-buy.mjs").CloudColor }
/** What opening a checkout did: `opened` in the browser; `signing-in` (signed
 * out, the browser signs in first); `conflict` (the account changed, now read
 * again); `rate-limited`; or `failed` (nothing was opened). */
export type CloudCheckoutOutcome = "opened" | "signing-in" | "conflict" | "rate-limited" | "failed";
export interface CloudCheckoutResult { outcome: CloudCheckoutOutcome; state: CloudAccountState }
export interface CloudAccountBridge {
  state(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  /** Only when the sign-in has ended: forget it and start a new one. */
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  /** What this person may buy now (cloud-account.mjs offer), or null. */
  offer?(): Promise<import("./cloud-home.mjs").CloudOffer | null>;
  /** Opens a checkout for a plan of the offer in the browser; `source` is one of CHECKOUT_SOURCES. */
  checkout?(plan: string, source: string): Promise<CloudCheckoutResult>;
  /** The email-code sign-in; the attempt and the token never reach the page. Absent on an older app. */
  signInStart?(email: string): Promise<CloudSignInStart>;
  signInVerify?(code: string): Promise<CloudSignInVerify>;
  signInCancel?(): Promise<void>;
  /** The checkout this app opened, again (never a new one while main keeps it); the plan and source only when none is kept. */
  reopenCheckout?(plan: string, source: string): Promise<CloudCheckoutResult>;
  /** Copies that checkout's page to the clipboard in main; false when none is kept. */
  copyCheckoutLink?(): Promise<boolean>;
  /** "Email me when I can add another". */
  interest?(): Promise<void>;
  /** The Cloud's name and colour (chosen while it is set up), and saving them. */
  look?(): Promise<CloudHomeLook>;
  setLook?(name: string, color: string): Promise<CloudHomeLook>;
  /** The buying sheet is open on this page (main then opens the ready Cloud there rather than notifying). */
  sheet?(open: boolean): Promise<void>;
  /** The sheet showed the ready Cloud: the purchase is over. */
  readySeen?(): Promise<void>;
  /** Lists the Cloud machine under Servers and opens it in this window. */
  connectHome(): Promise<CloudAccountState>;
  /** The same, opening the Cloud's Settings on its phone pairing. */
  connectHomeForPhone(): Promise<CloudAccountState>;
  onState(callback: (state: CloudAccountState) => void): () => void;
  /** "Let My Cloud use this computer" (docs/cloud-pro.md). */
  lending?: import("./computer-sharing.mjs").CloudLendingBridge;
  files?: import("./cloud-sync.mjs").CloudFilesBridge;
}
/** On the person's own Cloud, open in this app's window: the plan, read
 * only, and two ways out. No account, credential or address. */
/** `signin`: this computer's sign-in ended; `tier` names the plan last verified, if any. */
export interface CloudPlanSnapshot {
  status: "paid" | "attention" | "checking" | "signin" | "none";
  tier?: string;
  /** Verified: the free trial on the Cloud and its Claude credit. */
  trial?: import("./cloud-home.mjs").CloudTrial;
  credit?: import("./cloud-home.mjs").CloudCredit;
  /** The trial's popup due now, not yet shown today on either page. */
  notice?: import("./cloud-home.mjs").CloudTrialState;
}
export interface CloudPlanBridge {
  state(): Promise<CloudPlanSnapshot>;
  manage(): Promise<void>;
  useThisComputer(): Promise<void>;
  /** The trial's popup due now was shown: main shows it no more today. Absent on an older app. */
  noticeSeen?(): Promise<void>;
}

export declare const CLOUD_ORIGIN: string;
export declare const STAGING_CLOUD_ORIGIN: string;
export declare function cloudTarget(env?: Record<string, string | undefined>): {
  origin: string; staging: boolean;
  /** Under userData: the sign-in, saved servers, Files' folder, the Cloud's chosen name. */
  file: string; environments: string; sync: string; look: string;
};
export declare const CHECKOUT_SOURCES: readonly string[];
export declare function checkoutDestination(value: unknown, options?: { fixture?: boolean; staging?: boolean }): string | null;
export declare function cloudOrigin(value?: string, fixture?: boolean): string;
export interface CloudAccountStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
export declare function createCloudAccountStore(options: {
  file: string;
  encryption: {
    available(): boolean | Promise<boolean>;
    encrypt(value: string): Buffer | Promise<Buffer>;
    /** A string, or Electron 43's { shouldReEncrypt, result } (safeStorage.decryptStringAsync). */
    decrypt(value: Buffer): string | { result: string } | Promise<string | { result: string }>;
  };
}): CloudAccountStore;
export interface CloudAccountClient {
  state(): CloudAccountState;
  start(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  /** Only when the sign-in has ended: forget it and start a new one. */
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  offer(): Promise<import("./cloud-home.mjs").CloudOffer | null>;
  checkout(plan: string, source: string): Promise<CloudCheckoutResult>;
  emailStart(email: string): Promise<CloudSignInStart>;
  emailVerify(code: string): Promise<CloudSignInVerify>;
  emailCancel(): void;
  reopenCheckout(plan?: string, source?: string): Promise<CloudCheckoutResult>;
  /** Main only (the clipboard): the kept checkout page, or null. */
  checkoutLink(): string | null;
  /** The Cloud this checkout bought was opened, announced or shown ready. */
  checkoutDone(): void;
  /** Waiting on a checkout this app opened (the first 30 minutes). */
  checkoutPending(): boolean;
  interest(kind: "another_cloud"): Promise<void>;
  homeTarget(): { origin: string } | null;
  pairHome(): Promise<import("./cloud-home.mjs").CloudHomeGrant>;
  growDisk(sizeGb: number): Promise<{ supported: false } | { supported: true; refused: true } | { supported: true; disk: { gb: number; maxGb: number } }>;
  /** This sign-in's own X research relay access while its plan is paid; null without one. */
  xResearchAccess(): Promise<{ url: string; token: string } | null>;
  close(): void;
}
export declare function createCloudAccountClient(options: {
  store: CloudAccountStore;
  openBrowser(url: string): Promise<unknown>;
  platform: string;
  deviceName: string;
  appVersion?: string;
  origin?: string;
  /** Enables HTTP loopback only for isolated fixtures. Production main never sets it. */
  fixture?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  onState?: (state: CloudAccountState) => void;
  /** Told once per plan name this app predates. Defaults to console.warn. */
  warn?: (message: string) => void;
}): CloudAccountClient;
export declare function cloudPlanSnapshot(state: CloudAccountState | null | undefined, extra?: { notice?: import("./cloud-home.mjs").CloudTrialState | null }): CloudPlanSnapshot;
/** My Cloud's line under its name in the server menus, or null for none. */
export declare function cloudMenuSublabel(state: CloudAccountState | null | undefined, date: (value: number) => string): string | null;
