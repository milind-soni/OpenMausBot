import type { ConnectorResult } from "@/lib/analytics-allowlist";
import type { ConnectorStatus } from "@/lib/connector-status";

export const CONNECTOR_POLL_MS = 5_000;
export const CONNECTOR_POLL_TRIES = 24;

const ACTIVE = /^active$/i;
const ENDED = /^(expired|failed)$/i;

/** How the Connect that started from `before` ended, judged on the account it added: an older working account, or one
 * left from an abandoned attempt, says nothing about it. Without an account list, only the app turning connected counts. */
export function connectorPollEnd(before: ConnectorStatus | undefined, state: ConnectorStatus | undefined, tries: number): ConnectorResult | null {
  const known = new Map((before?.accounts ?? []).map((account) => [account.id, account.status]));
  const accounts = state?.accounts ?? [];
  if (accounts.some((account) => ACTIVE.test(account.status) && !ACTIVE.test(known.get(account.id) ?? ""))) return "connected";
  if (!accounts.length && state?.connected === true && before?.connected !== true) return "connected";
  const ended = accounts.find((account) => !known.has(account.id) && ENDED.test(account.status));
  if (ended) return ended.status.toLowerCase() as "expired" | "failed";
  return tries >= CONNECTOR_POLL_TRIES ? "timed_out" : null;
}

/** Polls one app after Connect until it ends; `onEnd` runs at most once, and never after `stop()`. */
export function pollConnector(
  before: ConnectorStatus | undefined,
  read: () => Promise<ConnectorStatus | undefined>,
  onEnd: (result: ConnectorResult) => void,
): () => void {
  let tries = 0;
  let ended = false;
  const stop = () => {
    ended = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    void Promise.resolve().then(read).catch(() => undefined).then((state) => {
      if (ended) return;
      const result = connectorPollEnd(before, state, ++tries);
      if (!result) return;
      stop();
      onEnd(result);
    });
  }, CONNECTOR_POLL_MS);
  return stop;
}
