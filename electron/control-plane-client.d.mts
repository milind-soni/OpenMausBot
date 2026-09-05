// Types for control-plane-client.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
export declare class ControlPlaneError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  constructor(code: string, status?: number, requestId?: string);
}

export declare function normalizeControlPlaneURL(value: unknown): string;
export declare function normalizeAccountEmail(value: unknown): string;

export interface ControlPlaneUser {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
}

export interface ControlPlaneInstallation {
  id: string;
  clientInstanceId: string;
  name: string;
  platform: string;
  appVersion?: string | null;
  createdAt?: number;
  updatedAt?: number;
  lastSeenAt?: number | null;
}

export interface ControlPlaneEndpoint {
  url: string;
  hostname: string;
  status: string;
  generation?: number;
  updatedAt?: number;
  lastReconciledAt?: number | null;
  lastErrorCode?: string | null;
}

export interface ControlPlaneClient {
  health(): Promise<unknown>;
  requestOTP(email: string): Promise<unknown>;
  verifyOTP(email: string, otp: string): Promise<{ accountToken: string; user: ControlPlaneUser }>;
  me(accountToken: string): Promise<ControlPlaneUser>;
  listInstallations(accountToken: string): Promise<ControlPlaneInstallation[]>;
  ensureInstallation(input: {
    accountToken: string;
    currentCredential: string;
    clientInstanceId: string;
    name: string;
    platform: string;
    appVersion?: string;
  }): Promise<{ installation: ControlPlaneInstallation; credential: string; credentialExpiresAt: number | null }>;
  ensureEndpoint(installationCredential: string): Promise<{ endpoint: ControlPlaneEndpoint; connectorToken: string }>;
  deleteEndpoint(installationCredential: string): Promise<void>;
  revokeInstallation(accountToken: string, installationId: string): Promise<void>;
  signOut(accountToken: string): Promise<void>;
}

export declare function createControlPlaneClient(options: {
  baseURL: string;
  fetchImpl?: typeof fetch;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  timeoutMs?: number;
  healthTimeoutMs?: number;
}): ControlPlaneClient;
