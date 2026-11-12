/** An app account was just (re)connected: connect cards still open for that same app and account, in any conversation of the last week, show it connected, and work parked on them carries on. */
import type { WireMessage as Message } from "../../shared/wire.ts";
import { NEEDS_YOU_WINDOW_MS } from "../../shared/today.ts";

export interface ConnectCardSettleDeps {
  threadsWithCards(since: number): readonly string[];
  messagesFor(threadId: string): readonly Message[];
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): unknown;
  /** Continues the turn parked on these cards once every card of its request is connected. */
  resume(threadId: string, resumeKey: string): unknown;
  now(): number;
}

const accountKey = (alias: string | undefined) => alias?.trim().toLowerCase() ?? "";

/** Returns how many cards it settled. MCP sign-in cards, and cards dismissed, superseded, stopped or resumed, are left as they are. */
export function settleOpenConnectCards(deps: ConnectCardSettleDeps, slug: string, alias?: string): number {
  const app = slug.toLowerCase();
  const account = accountKey(alias);
  let settled = 0;
  for (const threadId of deps.threadsWithCards(deps.now() - NEEDS_YOU_WINDOW_MS)) {
    const resumeKeys = new Set<string>();
    for (const message of deps.messagesFor(threadId)) {
      const card = message.kind === "connector" ? message.connector : undefined;
      if (!card || card.source === "mcp" || card.slug.toLowerCase() !== app || accountKey(card.alias) !== account) continue;
      if (card.status === "connected" || card.dismissed || card.superseded || card.stopped || card.resumed) continue;
      deps.patchMessage(threadId, message.id, { connector: { ...card, status: "connected", error: undefined } });
      resumeKeys.add(card.resumeKey);
      settled++;
    }
    for (const resumeKey of resumeKeys) deps.resume(threadId, resumeKey);
  }
  return settled;
}

type ServiceStatus = { connected?: boolean; accounts?: ReadonlyArray<{ alias?: string; status: string }> } | undefined;

/** The host's two moments an account connects: a connect card's own check, and Settings asking about apps it is connecting. */
export function createConnectCardSettle(deps: ConnectCardSettleDeps) {
  return {
    card: (slug: string, alias?: string) => settleOpenConnectCards(deps, slug, alias),
    services(services: Record<string, ServiceStatus>) {
      for (const [slug, service] of Object.entries(services)) {
        if (service?.connected) settleOpenConnectCards(deps, slug);
        for (const account of service?.accounts ?? []) if (account.alias && /^active$/i.test(account.status)) settleOpenConnectCards(deps, slug, account.alias);
      }
    },
  };
}
