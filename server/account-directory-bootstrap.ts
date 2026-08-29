import type { AccountDirectory, ExplicitAccountBinding } from "./account-directory.ts";
import type { ConnectorServiceState } from "./composio.ts";

/**
 * The smallest inventory shape needed by the bootstrapper. Keeping this
 * separate from Composio's implementation makes the import safe to test and
 * keeps the directory from ever receiving credentials or display metadata.
 */
export type ConnectedServiceInventory = Readonly<Record<string, ConnectorServiceState>>;

export interface AccountDirectoryBootstrapOptions {
  readonly observedAt?: string;
  readonly sourceIdPrefix?: string;
}

export type AccountDirectoryBootstrapSkipReason =
  | "no-auth-toolkit"
  | "unaliased-account"
  | "not-active"
  | "invalid-reference";

export interface AccountDirectoryBootstrapSkip {
  readonly provider: string;
  readonly accountId?: string;
  readonly reason: AccountDirectoryBootstrapSkipReason;
}

export interface ExplicitBindingExtractionResult {
  readonly bindings: ReadonlyArray<ExplicitAccountBinding>;
  readonly skipped: ReadonlyArray<AccountDirectoryBootstrapSkip>;
  readonly observedAt: string;
}

export interface AccountDirectoryBootstrapResult {
  readonly status: "completed" | "failed";
  readonly observedAt: string;
  readonly accepted: number;
  readonly duplicates: number;
  readonly skipped: ReadonlyArray<AccountDirectoryBootstrapSkip>;
  readonly rejected: ReadonlyArray<{ readonly provider: string; readonly accountId?: string; readonly reason: string }>;
  readonly error?: string;
}

/**
 * Convert connected-app inventory to explicit account bindings.
 *
 * An alias is the only accepted logical identity. In particular, this never
 * falls back to an email, toolkit label, account ID, or display name. A
 * connected account must also be active: pending/expired/revoked records do
 * not prove that a credential is available to the runtime.
 */
export function explicitBindingsFromConnectedServices(
  inventory: ConnectedServiceInventory,
  options: AccountDirectoryBootstrapOptions = {},
): ExplicitBindingExtractionResult {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const sourceIdPrefix = options.sourceIdPrefix ?? "composio";
  const bindings: ExplicitAccountBinding[] = [];
  const skipped: AccountDirectoryBootstrapSkip[] = [];

  for (const [provider, service] of Object.entries(inventory)) {
    // No-auth toolkits have no account identity to bind. The optional marker
    // is supported by managed brokers; an empty account list is the normal
    // self-hosted representation.
    if (service.noAuth === true || service.accounts.length === 0) {
      skipped.push({ provider, reason: "no-auth-toolkit" });
      continue;
    }

    for (const account of service.accounts) {
      const accountId = account.id;
      const alias = account.alias?.trim() ?? "";
      if (!accountId) {
        skipped.push({ provider, reason: "invalid-reference" });
        continue;
      }
      if (!alias) {
        skipped.push({ provider, accountId, reason: "unaliased-account" });
        continue;
      }
      if (!/^active$/i.test(account.status)) {
        skipped.push({ provider, accountId, reason: "not-active" });
        continue;
      }
      bindings.push({
        identity: alias,
        provider,
        accountId,
        source: "connected-app",
        sourceId: `${sourceIdPrefix}:${provider}:${accountId}`,
        observedAt,
        evidenceRef: `connected-account:${accountId}`,
      });
    }
  }

  return { bindings, skipped, observedAt };
}

/**
 * Reconcile an inventory into the durable directory. Registration is already
 * idempotent; this wrapper deliberately catches per-record failures so one
 * malformed or conflicting provider record cannot prevent other safe records
 * from being imported.
 */
export function bootstrapAccountDirectory(
  directory: AccountDirectory,
  inventory: ConnectedServiceInventory,
  options: AccountDirectoryBootstrapOptions = {},
): AccountDirectoryBootstrapResult {
  const { bindings, skipped, observedAt } = explicitBindingsFromConnectedServices(inventory, options);
  let accepted = 0;
  let duplicates = 0;
  const rejected: Array<{ provider: string; accountId?: string; reason: string }> = [];

  for (const binding of bindings) {
    try {
      const result = directory.register({ ownerId: directory.getOwnerId(), ...binding });
      if (result.status === "accepted") accepted += 1;
      else duplicates += 1;
    } catch (error) {
      rejected.push({
        provider: binding.provider,
        accountId: binding.accountId,
        reason: error instanceof Error ? error.message : "The account binding was rejected",
      });
    }
  }

  return { status: "completed", observedAt, accepted, duplicates, skipped, rejected };
}

/**
 * Startup adapter. Inventory failures are intentionally nonfatal: the
 * caller can expose the returned failed state through its status endpoint and
 * retry later after the connector/auth service recovers.
 */
export async function bootstrapAccountDirectoryFromInventory(
  directory: AccountDirectory,
  loadInventory: () => Promise<ConnectedServiceInventory>,
  options: AccountDirectoryBootstrapOptions = {},
): Promise<AccountDirectoryBootstrapResult> {
  const observedAt = options.observedAt ?? new Date().toISOString();
  try {
    const inventory = await loadInventory();
    return bootstrapAccountDirectory(directory, inventory, { ...options, observedAt });
  } catch (error) {
    return {
      status: "failed",
      observedAt,
      accepted: 0,
      duplicates: 0,
      skipped: [],
      rejected: [],
      error: error instanceof Error ? error.message : "Connected account inventory was unavailable",
    };
  }
}
