// Types for companion-account-service.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
import type { ControlPlaneClient } from "./control-plane-client.mjs";

export declare const DEFAULT_COMPANION_CONTROL_PLANE_URL: string;
export declare const COMPANION_CLIENT_INSTANCE_FIELD: string;
export declare const COMPANION_ACCOUNT_TOKEN_FIELD: string;
export declare const COMPANION_ACCOUNT_USER_ID_FIELD: string;
export declare const COMPANION_ACCOUNT_EMAIL_FIELD: string;
export declare const COMPANION_INSTALLATION_ID_FIELD: string;
export declare const COMPANION_INSTALLATION_CREDENTIAL_FIELD: string;
export declare const COMPANION_INSTALLATION_EXPIRY_FIELD: string;
export declare const COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD: string;
export declare const COMPANION_ENDPOINT_PAUSED_FIELD: string;
export declare const PHONE_UNUSED_RELEASE_MS: number;

export type CredentialDocument = Record<string, unknown>;

export declare function resolveCompanionControlPlaneURL(options?: {
  isPackaged?: boolean;
  environment?: NodeJS.ProcessEnv;
}): string;
export declare function companionAccountCleanupPending(credentials: CredentialDocument): boolean;
/** true while a pairing window is open or a paired device was seen in the
 * last 30 days (or is connected, or has no known last-seen time); "unused"
 * when devices are paired but none was seen for 30 days; false only for a
 * cleanly read empty device list; null when that cannot be told. */
export declare function managedEndpointNeed(state: unknown, now?: number): boolean | "unused" | null;
export declare function friendlyCompanionAccountError(error: unknown): string;

export interface CompanionAccountState {
  available: boolean;
  status: string;
  email?: string;
  endpoint?: string;
  message?: string;
  /** The address was given back after 30 days with no paired phone seen; prepare() brings it back. */
  paused?: true;
}

export interface CompanionAccountService {
  state(): Promise<CompanionAccountState>;
  requestCode(email: string): Promise<CompanionAccountState>;
  verifyCode(email: string, code: string): Promise<CompanionAccountState>;
  retry(): Promise<CompanionAccountState>;
  /** On demand: create or repair the address because a person is pairing. */
  prepare(): Promise<CompanionAccountState>;
  signOut(): Promise<CompanionAccountState>;
  restore(): Promise<CompanionAccountState>;
  /** Cancels background recovery timers (autoRecover only). */
  dispose(): void;
}

export declare function createCompanionAccountService(options: {
  client: ControlPlaneClient | null;
  readCredentials: () => CredentialDocument;
  updateCredentials: (
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ) => Promise<unknown>;
  identity: { name: string; platform: string; appVersion?: string };
  newClientInstanceId: () => string;
  activatePersistedEndpoint?: () => Promise<{ status: string; ready: boolean }>;
  stopManagedEndpoint?: () => Promise<void>;
  managedConnectionState?: () => { status: string; ready: boolean };
  companionIsOn?: () => boolean;
  now?: () => number;
  healthCacheMs?: number;
  autoRecover?: boolean;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  autoRetryBaseMs?: number;
  autoRetryMaxMs?: number;
  endpointCheckIntervalMs?: number;
  firstEndpointCheckMs?: number;
  /** Hold the address only while something needs it (the desktop app). */
  onDemand?: boolean;
  managedEndpointNeeded?: () => Promise<boolean | "unused" | null>;
  releaseGraceMs?: number;
  releaseJitterMs?: number;
  /** One line per failed setup step: code, HTTP status, request id, retry delay. */
  log?: (line: string) => void;
}): CompanionAccountService;
