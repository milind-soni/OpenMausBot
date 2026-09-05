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

export type CredentialDocument = Record<string, unknown>;

export declare function resolveCompanionControlPlaneURL(options?: {
  isPackaged?: boolean;
  environment?: NodeJS.ProcessEnv;
}): string;
export declare function companionAccountCleanupPending(credentials: CredentialDocument): boolean;
export declare function friendlyCompanionAccountError(error: unknown): string;

export interface CompanionAccountState {
  available: boolean;
  status: string;
  email?: string;
  endpoint?: string;
  message?: string;
}

export interface CompanionAccountService {
  state(): Promise<CompanionAccountState>;
  requestCode(email: string): Promise<CompanionAccountState>;
  verifyCode(email: string, code: string): Promise<CompanionAccountState>;
  retry(): Promise<CompanionAccountState>;
  signOut(): Promise<CompanionAccountState>;
  restore(): Promise<CompanionAccountState>;
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
}): CompanionAccountService;
