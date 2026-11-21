// Types for control-plane-client.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
export declare class ControlPlaneError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  /** Server-requested delay from a Retry-After header, or 0. */
  readonly retryAfterMs: number;
  constructor(code: string, status?: number, requestId?: string, retryAfterMs?: number);
}

/** Sent only when given: a self-hosted server says `server`, and the control plane never gives its tunnel to the relay. */
export type InstallationKind = "desktop" | "server";

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
    kind?: InstallationKind;
  }): Promise<{ installation: ControlPlaneInstallation; credential: string; credentialExpiresAt: number | null }>;
  /** `appVersion`, when printable and at most 64 characters, is sent as the
   * release this installation runs. */
  ensureEndpoint(
    installationCredential: string,
    options?: { appVersion?: string; kind?: InstallationKind },
  ): Promise<{ endpoint: ControlPlaneEndpoint; connectorToken: string }>;
  /** MausBot Relay: the control plane's 200 body (checked by relay-token.mjs's validRelayGrant), or a
   * ControlPlaneError with code `relay_unavailable` (503) outside the rollout. */
  relayToken(
    installationCredential: string,
    options: { appVersion: string; devices: { e2e: number; legacy: number }; kind?: InstallationKind },
  ): Promise<unknown>;
  getEndpoint(installationCredential: string): Promise<{ url: string; status: string } | null>;
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
