// Per-app OAuth against an OpenConnector runtime. One app (service) gets its own OAuth client:
// OpenMausBot reads the runtime's expectedRedirectUri, PUTs the client credentials to the runtime
// (which is where they live), and keeps only a sealed local copy for display and re-PUT. The browser
// round trip is never run by tests: this module stops at the authorization URL and the polling that
// follows it, both mockable against any stub.
import { inputError } from "../../composio-project.ts";
import { OpenConnectorError, type OpenConnectorClient } from "./client.ts";
import type { OpenConnectorConnectionRecord, OpenConnectorStateStore } from "./state.ts";
import { accountIdForConnection } from "./state.ts";

export interface AppOAuthInput {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

/** GET /api/oauth/configs -> expectedRedirectUri, then PUT /api/oauth/configs/:service, then seal the
 * local record. The runtime is the source of truth for the secret; the local copy is display-only. */
export async function configureAppOAuth(
  client: OpenConnectorClient,
  state: OpenConnectorStateStore,
  service: string,
  input: AppOAuthInput,
): Promise<{ expectedRedirectUri?: string }> {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId) throw inputError("OAuth clientId is required");
  if (!clientSecret) throw inputError("OAuth clientSecret is required");
  const scopes = (input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean);
  const expectedUpdatedAt = state.findAppOAuth(service)?.updatedAt ?? null;
  const { expectedRedirectUri } = await client.oauthConfigs();
  await client.putOauthConfig(service, { clientId, clientSecret, scopes });
  state.upsertAppOAuth({
    service,
    clientId,
    scopes,
    sealedClientSecret: state.sealSecret(clientSecret),
    updatedAt: new Date().toISOString(),
  }, expectedUpdatedAt);
  return { expectedRedirectUri };
}

/** What the person sees before connecting: the runtime's redirect target plus what this host saved. */
export async function appOAuthStatus(
  client: OpenConnectorClient,
  state: OpenConnectorStateStore,
  service: string,
): Promise<{ configured: boolean; expectedRedirectUri?: string; clientId?: string; scopes?: string[] }> {
  const { data, expectedRedirectUri } = await client.oauthConfigs();
  const local = state.findAppOAuth(service);
  const runtimeHas = runtimeHasConfig(data, service);
  return {
    configured: runtimeHas,
    expectedRedirectUri,
    clientId: local?.clientId,
    scopes: local?.scopes,
  };
}

function runtimeHasConfig(data: unknown, service: string): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const doc = data as Record<string, unknown>;
  const configs = doc.configs && typeof doc.configs === "object" && !Array.isArray(doc.configs)
    ? doc.configs as Record<string, unknown>
    : doc;
  const entry = configs[service];
  return Boolean(entry && typeof entry === "object" && Object.keys(entry).length);
}

const TERMINAL_OK = new Set(["connected"]);
const TERMINAL_BAD = new Set(["failed", "error", "expired", "cancelled", "canceled", "denied", "revoked"]);
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PollResult {
  status: string;
  connected: boolean;
  record: OpenConnectorConnectionRecord;
}

/** Poll GET /v1/connection-requests/:id no faster than the runtime asks (Retry-After wins), then fold
 * the terminal state back into the local registry record. Throws on timeout. */
export async function pollConnectionRequest(
  client: OpenConnectorClient,
  state: OpenConnectorStateStore,
  service: string,
  requestId: string,
  alias: string | undefined,
  options: PollOptions = {},
): Promise<PollResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    let body: Record<string, unknown> | null = null;
    let retryAfterMs: number | undefined;
    try {
      ({ state: body, retryAfterMs } = await client.connectionRequest(requestId));
    } catch (error) {
      // A throttled poll is transient: honor Retry-After and keep waiting; anything else fails the flow.
      if (error instanceof OpenConnectorError && error.status === 429) {
        retryAfterMs = error.retryAfterMs;
      } else {
        throw error;
      }
    }
    if (body) {
      const status = typeof body.status === "string" ? body.status
        : typeof body.state === "string" ? body.state
          : body.connected === true ? "connected"
            : "pending";
      if (TERMINAL_OK.has(status) || TERMINAL_BAD.has(status)) {
        const accountId = accountIdForConnection(service, alias);
        const record = state.updateConnectionIf(accountId, requestId, (existing) => ({
          accountId,
          service,
          ...(alias ? { alias } : {}),
          ...(existing.label ? { label: existing.label } : {}),
          connectionRequestId: requestId,
          status,
          updatedAt: new Date().toISOString(),
        }));
        if (!record) {
          throw new Error(`The ${service} authorization was superseded`);
        }
        return { status, connected: TERMINAL_OK.has(status), record };
      }
    }
    const waitMs = Math.max(retryAfterMs ?? 0, intervalMs);
    if (now() + waitMs > deadline) {
      throw new Error(`Timed out waiting for the ${service} authorization to finish`);
    }
    await sleep(waitMs);
  }
}
