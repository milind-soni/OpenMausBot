// The proxy-side half of computer control. The harness keeps the record of
// who is driving (server/computer-control.ts); the per-turn computer
// processes consult it through this client before acting, because the
// action paths themselves never traverse the harness — a box click goes
// straight to the box's REST API, and a Local VM / VPS click rides a
// transparent stdio bridge into Cua Driver.
//
// Failure posture: CLOSED once configured. A missing/expired turn capability
// must never be interpreted as "the person released control": that would let
// a stale computer proxy resume acting underneath them. An unconfigured
// client remains disengaged because there is no control surface to consult.
//
// The state is cached briefly so a computer_batch of two dozen actions
// doesn't turn into two dozen loopback round trips.

export interface ControlState {
  /** The person is driving; actions must be refused, not queued. */
  held: boolean;
  /** A help request the person has neither answered nor dismissed. */
  helpOpen: boolean;
}

export interface ControlClient {
  /** Current state, cached for `cacheMs`. `fresh` bypasses the cache —
   * the wait loop in request-help polls with it so a hand-back is seen
   * within one poll interval, not one poll interval plus the cache. */
  state(fresh?: boolean): Promise<ControlState>;
  /** Surface the bot's plea in the app. Returns its expiry id, or null when
   * the harness could not be told. */
  requestHelp(reason: string): Promise<string | null>;
  /** Close only the unanswered plea opened by this client. */
  expireHelp(requestId: string): Promise<void>;
  readonly configured: boolean;
}

const DISENGAGED: ControlState = { held: false, helpOpen: false };
const UNAVAILABLE: ControlState = { held: true, helpOpen: false };

export function createControlClient(options?: {
  url?: string;
  token?: string;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
}): ControlClient {
  const url = options?.url ?? process.env.OMB_CONTROL_URL ?? "";
  const token = options?.token ?? process.env.OMB_CONTROL_TOKEN ?? "";
  const cacheMs = options?.cacheMs ?? 750;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const configured = Boolean(url && token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let cachedAt = 0;
  let cached: ControlState = DISENGAGED;

  async function read(): Promise<ControlState> {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return UNAVAILABLE;
      const body: any = await res.json().catch(() => null);
      return { held: body?.held === true, helpOpen: body?.helpOpen === true };
    } catch {
      return UNAVAILABLE;
    }
  }

  return {
    configured,
    async state(fresh = false): Promise<ControlState> {
      if (!configured) return DISENGAGED;
      const now = Date.now();
      if (!fresh && now - cachedAt < cacheMs) return cached;
      cached = await read();
      cachedAt = Date.now();
      return cached;
    },
    async requestHelp(reason: string): Promise<string | null> {
      if (!configured) return null;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason }),
          signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) return null;
        const body: any = await res.json().catch(() => null);
        return typeof body?.requestId === "string" && body.requestId ? body.requestId : null;
      } catch {
        return null;
      }
    },
    async expireHelp(requestId: string): Promise<void> {
      if (!configured || !requestId) return;
      try {
        await fetchImpl(url, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // Best effort: the harness also clears the in-memory request on
        // release/restart, and an unavailable harness cannot show the card.
      }
    },
  };
}

/** The one sentence every refused action gets. Deliberately does not vary
 * per tool: the model needs the same three facts every time — nothing
 * happened, don't retry blindly, and how to wait properly. */
export const CONTROL_REFUSAL =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not retry it — the screen is changing under their hands. " +
  "Call computer_request_help (no reason needed) to wait for them to finish, " +
  "then take a fresh screenshot before your next action.";

/** The bridge-gated computers (Local VM, VPS) speak Cua Driver's own tool
 * surface, which has no wait tool to point at — so the guidance is to
 * pause, not to call anything. */
export const CONTROL_REFUSAL_PLAIN =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not retry it — the screen is changing under their hands. " +
  "Pause this task, tell the person you are waiting for them to hand control back, " +
  "and take a fresh screenshot before your next action once they have.";
