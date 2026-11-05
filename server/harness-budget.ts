/** How long the agent's stdio proxy waits for the harness to answer one browser, computer or data call. */
export const HARNESS_PROXY_TIMEOUT_MS = 130_000;
/** Everything the harness does for one call fits in this, so its answer reaches the proxy before the proxy gives up. */
export const HARNESS_CALL_BUDGET_MS = 120_000;

/** One device call: the send hold waiting on the person (OUTBOUND_HOLD_MS, 9 min) + the send's phone job
 * (PHONE_SEND_TIMEOUT_MS, 120 s) + the phone's reconnect window (PHONE_RECONNECT_WAIT_MS, 15 s) + a 30 s margin = 705 s.
 * Written out rather than imported, so the stdio proxy that reads this file loads neither the hold nor zod;
 * harness-mcp-proxy.test.ts holds it to the sum of the real constants. */
export const DEVICE_PROXY_TIMEOUT_MS = 9 * 60_000 + 120_000 + 15_000 + 30_000;
/** A cloud computer file copy streams up to 2 GiB, so it gets longer than other calls, still under the chat engine's
 * 10-minute limit on one tool call. */
export const COMPUTER_COPY_BUDGET_MS = 9 * 60_000;
/** Outwaits the longest cloud computer call; Codex, which ends a tool call itself, waits a little longer still. */
export const COMPUTER_PROXY_TIMEOUT_MS = COMPUTER_COPY_BUDGET_MS + 10_000;
export const HARNESS_PROXY_TIMEOUTS_MS: Partial<Record<"browser" | "computer" | "data" | "highlevel" | "email" | "device", number>> = {
  device: DEVICE_PROXY_TIMEOUT_MS, computer: COMPUTER_PROXY_TIMEOUT_MS,
};
