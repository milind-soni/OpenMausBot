export interface CloudAccountState {
  status: "signed-out" | "connecting" | "connected" | "reauth-required" | "unavailable";
  message?: string;
  enrollment?: { userCode: string; expiresAt: number };
  account?: { id: string; email: string };
  deviceId?: string;
  expiresAt?: number;
  /** Only a current server-verified session can include an entitlement. */
  entitlement?: { plan: "free" | "pro"; status: "active" | "inactive"; expiresAt: number | null; version: number };
  verifiedAt?: number;
  verifiedUntil?: number;
  /** The person's Cloud home machine, when their plan has one. */
  machine?: import("./cloud-home.mjs").CloudMachine;
}
export interface CloudAccountBridge {
  state(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  /** Lists the Cloud machine under Servers and opens it in this window. */
  connectHome(): Promise<CloudAccountState>;
  onState(callback: (state: CloudAccountState) => void): () => void;
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
    decrypt(value: Buffer): string | Promise<string>;
  };
}): CloudAccountStore;
export interface CloudAccountClient {
  state(): CloudAccountState;
  start(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  homeTarget(): { origin: string } | null;
  pairHome(): Promise<import("./cloud-home.mjs").CloudHomeGrant>;
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
}): CloudAccountClient;
