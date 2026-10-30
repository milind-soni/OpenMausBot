// The HighLevel connection as one object: its store, API client, sign-in flow and the status the app shows.
// Desktop and Cloud home build the same service; only DATA_DIR and the relay URL differ.
import type { HighLevelStatus } from "../../shared/highlevel.ts";
import { HIGHLEVEL_API_ENV, HighLevelClient, HighLevelError, lookupLocation } from "./client.ts";
import { createHighLevelRelay, highlevelRelayUrl, type HighLevelRelay } from "./relay.ts";
import { HighLevelSignIn } from "./sign-in.ts";
import { HighLevelStore, type HighLevelConnection } from "./store.ts";

export interface HighLevelServiceOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  pollMs?: number;
  /** Status changes the app may want to push (connected, signed out). */
  onChange?(): void;
}

export interface HighLevelService {
  readonly store: HighLevelStore;
  readonly client: HighLevelClient;
  readonly relayUrl: string | null;
  connected(): boolean;
  status(): HighLevelStatus;
  startSignIn(): Promise<{ flowId: string; authorizationUrl: string; expiresAt: number }>;
  signInStatus(flowId: string): ReturnType<HighLevelSignIn["status"]>;
  cancelSignIn(flowId: string): boolean;
  connectWithToken(token: string, locationId: string): Promise<HighLevelStatus>;
  disconnect(): HighLevelStatus;
  /** A connection moved here from the person's own computer; one already signed in here is kept, unless `replaces` says
   * it is the one that computer moved here before. */
  adopt(connection: HighLevelConnection, replaces?: (current: HighLevelConnection) => boolean): "adopted" | "kept";
  close(): void;
}

const PIT = /^pit-[A-Za-z0-9_-]{8,}$/u;
const LOCATION_ID = /^[A-Za-z0-9_-]{4,64}$/u;

export function createHighLevelService(options: HighLevelServiceOptions): HighLevelService {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const relayUrl = highlevelRelayUrl(env);
  const relay: HighLevelRelay | null = relayUrl ? createHighLevelRelay(relayUrl, fetchImpl) : null;
  // The API base is fixed; the env override exists for tests against a fake HighLevel.
  const apiUrl = env[HIGHLEVEL_API_ENV];
  const store = new HighLevelStore({ dataDir: options.dataDir, now });
  const client = new HighLevelClient({ store, refresh: relay ? (token) => relay.refresh(token) : null, apiUrl, fetch: fetchImpl, now });
  const lookupName = async (accessToken: string, locationId: string) => (await lookupLocation({ token: accessToken, locationId, apiUrl, fetch: fetchImpl })).name;
  const signIn = relay ? new HighLevelSignIn({ relay, store, lookupLocationName: lookupName, now, pollMs: options.pollMs, onChange: options.onChange }) : null;

  const status = (): HighLevelStatus => {
    const connection = store.get();
    const flow = signIn?.active();
    if (flow) return { state: "connecting", flow: { flowId: flow.flowId, authorizationUrl: flow.authorizationUrl, expiresAt: flow.expiresAt } };
    if (connection) {
      return {
        state: connection.state === "signed-in" ? "connected" : "needs-sign-in",
        kind: connection.kind,
        location: { id: connection.locationId, name: connection.locationName ?? connection.locationId },
        connectedAt: connection.connectedAt,
        ...(connection.problem ? { problem: connection.problem } : {}),
      };
    }
    return { state: relayUrl ? "signed-out" : "unavailable" };
  };

  return {
    store, client, relayUrl,
    connected: () => store.get()?.state === "signed-in",
    status,
    async startSignIn() {
      if (!signIn) throw new HighLevelError("HighLevel sign-in is not available: no OpenMausBot relay is configured. Use a Private Integration token instead.", { status: 503 });
      return signIn.start();
    },
    signInStatus: (flowId) => signIn?.status(flowId) ?? null,
    cancelSignIn: (flowId) => signIn?.cancel(flowId) ?? false,
    async connectWithToken(token, locationId) {
      const trimmed = token.trim();
      if (!PIT.test(trimmed)) throw new HighLevelError("Paste a Private Integration token. It starts with pit-.", { status: 400 });
      if (!LOCATION_ID.test(locationId.trim())) throw new HighLevelError("Enter the location id (Settings → Business Profile in HighLevel).", { status: 400 });
      const location = await lookupLocation({ token: trimmed, locationId: locationId.trim(), apiUrl, fetch: fetchImpl });
      if (signIn) for (const flow of [signIn.active()]) if (flow) signIn.cancel(flow.flowId);
      store.put({ kind: "token", accessToken: trimmed, locationId: location.id, ...(location.companyId ? { companyId: location.companyId } : {}), locationName: location.name, scopes: "" });
      options.onChange?.();
      return status();
    },
    disconnect() {
      if (signIn) for (const flow of [signIn.active()]) if (flow) signIn.cancel(flow.flowId);
      store.clear();
      options.onChange?.();
      return status();
    },
    adopt(connection, replaces) {
      const current = store.get();
      if (current?.state === "signed-in" && !replaces?.(current)) return "kept";
      if (signIn) for (const flow of [signIn.active()]) if (flow) signIn.cancel(flow.flowId);
      store.put(connection);
      options.onChange?.();
      return "adopted";
    },
    close: () => signIn?.close(),
  };
}
