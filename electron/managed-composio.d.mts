export interface ManagedComposioCredentials {
  composioBrokerToken?: string;
  composioInstallationId?: string;
  [key: string]: unknown;
}

export interface ManagedComposioAccess { url: string; token: string }

export declare const DEFAULT_MANAGED_COMPOSIO_BROKER_URL: string;
export declare function managedComposioBrokerUrl(configured: string | undefined, shipped: boolean): string;
export declare function normalizeManagedComposioBrokerUrl(value: unknown): string;
export declare function managedComposioAccess(
  brokerUrl: string,
  credentials: ManagedComposioCredentials | null | undefined,
): ManagedComposioAccess | null;
export declare function managedComposioChildEnvironment(
  brokerUrl: string,
  credentials: ManagedComposioCredentials | null | undefined,
  environment: Record<string, string | undefined>,
): Record<string, string | undefined>;
/** Checks a held token with /v1/me and registers a new installation only when there is none or the service refused it
 * (401); any other failure keeps the token. Never throws: a failure is logged and `credentials` comes back as it is. */
export declare function ensureManagedComposioCredentials<T extends ManagedComposioCredentials>(options: {
  brokerUrl: string;
  credentials: T;
  fetchImpl?: typeof fetch;
  saveCredentials: (credentials: T) => Promise<void> | void;
  log?: (line: string) => void;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  existingCredentialTimeoutMs?: number;
  registrationTimeoutMs?: number;
}): Promise<T>;
