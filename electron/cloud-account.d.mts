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
}
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
  /** Lists the Cloud machine under Servers and opens it in this window. */
  connectHome(): Promise<CloudAccountState>;
  /** The same, opening the Cloud's Settings on its phone pairing. */
  connectHomeForPhone(): Promise<CloudAccountState>;
  onState(callback: (state: CloudAccountState) => void): () => void;
  /** "Let my Cloud use this Mac" (docs/cloud-pro.md). */
  lending?: import("./computer-sharing.mjs").CloudLendingBridge;
}
/** On the person's own Cloud, open in this app's window: the plan, read
 * only, and two ways out. No account, credential or address. */
/** `signin`: this computer's sign-in ended; `tier` names the plan last verified, if any. */
export interface CloudPlanSnapshot { status: "paid" | "attention" | "checking" | "signin" | "none"; tier?: string }
export interface CloudPlanBridge {
  state(): Promise<CloudPlanSnapshot>;
  manage(): Promise<void>;
  useThisComputer(): Promise<void>;
}

export declare const CLOUD_ORIGIN: string;
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
export declare function cloudPlanSnapshot(state: CloudAccountState | null | undefined): CloudPlanSnapshot;
