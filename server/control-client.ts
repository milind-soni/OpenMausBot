// Fails closed once configured: an unanswered check must never read as "the person released control", nor as "a person
// took control", whose text is reserved for the harness saying a person holds the computer.

/** Under the 60 seconds an engine may give one tool call (Codex's default), with room for the action itself. */
export const CONTROL_WAIT_MS = 45_000;
/** A call that waited longer is not performed: a late action could outlive a call the engine already retried, and happen twice. */
export const CONTROL_ACT_WITHIN_MS = 5_000;
/** Past the harness's longest answer, so a check it still legitimately holds is never cut off and misread. */
const READ_TIMEOUT_MS = CONTROL_WAIT_MS + 10_000;
const WAIT_WORDS = `${CONTROL_WAIT_MS / 1000} seconds`;

/** Only while a person holds the computer (the harness marks it `reason: "person"`). */
export const CONTROL_REFUSAL_PLAIN =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not act until they hand it back — the screen is changing under their hands. " +
  `To wait for them, take a screenshot: each computer call waits up to ${WAIT_WORDS} and returns as soon as they hand control back. ` +
  "Meanwhile you may work on anything that does not need this computer.";
/** Not forwarded: a click composed before their hands moved must never land on whatever is under it now. */
export const CONTROL_HANDED_BACK =
  "The person has handed this computer back. This call was NOT performed — the screen may have changed while they had it. " +
  "Take a fresh screenshot, then continue the task.";
export const CONTROL_WAITED =
  "This computer is free now, but this call had to wait for it, so it was NOT performed. " +
  "Call again: the next call goes through at once. If you meant to click or type from an earlier screenshot, take a fresh one first — the screen may have changed while you waited.";
export const CONTROL_BUSY =
  "Another thread is using this computer. This call was not performed. This turn gets the computer as soon as it is free: " +
  `to keep waiting, take a screenshot (each computer call waits up to ${WAIT_WORDS}) instead of ending your turn.`;
export const CONTROL_UNCONFIRMED =
  "OpenMausBot could not confirm that this computer is free, so this call was NOT performed and nothing happened on the screen. " +
  "Retry in a few seconds.";

export interface ControlState {
  held: boolean;
  helpOpen: boolean;
  /** "person" only when the harness says a person holds the computer. */
  reason?: "person";
  blockedReason?: string;
}

export interface ControlClient {
  /** `call`: what a tools/call would open, sent along so a first ask can name it; such a read is never cached. */
  state(fresh?: boolean, call?: Record<string, string>): Promise<ControlState>;
  readonly configured: boolean;
}

const DISENGAGED: ControlState = { held: false, helpOpen: false };
const UNCONFIRMED: ControlState = { held: true, helpOpen: false, blockedReason: CONTROL_UNCONFIRMED };

export function controlRefusal(state: Pick<ControlState, "reason" | "blockedReason">): string {
  return state.blockedReason ?? (state.reason === "person" ? CONTROL_REFUSAL_PLAIN : CONTROL_UNCONFIRMED);
}

export function createControlClient(options?: {
  url?: string;
  token?: string;
  cacheMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): ControlClient {
  const url = options?.url ?? process.env.OMB_CONTROL_URL ?? "";
  const token = options?.token ?? process.env.OMB_CONTROL_TOKEN ?? "";
  const cacheMs = options?.cacheMs ?? 750;
  const timeoutMs = options?.timeoutMs ?? READ_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const configured = Boolean(url && token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let cachedAt = 0;
  let cached: ControlState = DISENGAGED;

  async function read(call?: Record<string, string>): Promise<ControlState> {
    try {
      let target = url;
      if (call && Object.keys(call).length) {
        const withCall = new URL(url);
        for (const [key, value] of Object.entries(call)) withCall.searchParams.set(key, value);
        target = withCall.href;
      }
      const res = await fetchImpl(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return UNCONFIRMED;
      const body: any = await res.json().catch(() => null);
      if (typeof body?.held !== "boolean" || typeof body?.helpOpen !== "boolean") return UNCONFIRMED;
      return {
        held: body.held,
        helpOpen: body.helpOpen,
        ...(body.reason === "person" ? { reason: "person" as const } : {}),
        ...(typeof body.blockedReason === "string" && body.blockedReason.trim() ? { blockedReason: body.blockedReason } : {}),
      };
    } catch {
      return UNCONFIRMED;
    }
  }

  return {
    configured,
    async state(fresh = false, call?: Record<string, string>): Promise<ControlState> {
      if (!configured) return DISENGAGED;
      const now = Date.now();
      if (!fresh && !call && now - cachedAt < cacheMs) return cached;
      cached = await read(call);
      cachedAt = Date.now();
      return cached;
    },
  };
}
