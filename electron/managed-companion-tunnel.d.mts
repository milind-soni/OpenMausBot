// Types for managed-companion-tunnel.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
export declare const MANAGED_COMPANION_ENDPOINT_FIELD: string;
export declare const MANAGED_COMPANION_TOKEN_FIELD: string;

export interface ManagedTunnelAccess {
  endpoint: string;
  token: string;
}

export interface ManagedTunnelState {
  status: string;
  ready: boolean;
  configured?: boolean;
  error?: string;
  retryInMs?: number;
}

export interface ManagedTunnelOriginTarget {
  pid: number;
  socketPath: string;
}

export interface ManagedTunnel {
  start(access: ManagedTunnelAccess & { originTarget: ManagedTunnelOriginTarget }): Promise<ManagedTunnelState>;
  stop(): Promise<ManagedTunnelState>;
  shutdown(): Promise<ManagedTunnelState>;
}

export declare function normalizeManagedCompanionEndpoint(value: unknown): string;
export declare function managedCompanionTunnelAccess(credentials: Record<string, unknown>): ManagedTunnelAccess | null;
export declare function resolveCloudflaredBinary(options?: {
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}): string | null;
export declare function createManagedCompanionTunnel(options: {
  binaryPath: string | null;
  guardianEntry: string | null;
  runtimeExecutable?: string;
  originPort?: number;
  runtimeRoot: string;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  verifyTimeoutMs?: number;
  verifyRequestTimeoutMs?: number;
  verifyIntervalMs?: number;
  stopGraceMs?: number;
  maxRetryMs?: number;
  onChange?: (state: ManagedTunnelState) => void;
  log?: (line: string) => void;
}): ManagedTunnel;
