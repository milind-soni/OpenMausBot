// The connection a draft card's Save or Send runs through (email-draft-card.ts): the bot's connected apps, checked against
// the Rules and the bot's app permissions now and again right before the call goes out, the way its own calls are.
import { connectorAccessDecision } from "../../shared/connector-scopes.ts";
import type { ConnectorCall } from "../../shared/outbound.ts";
import { evaluateConnectorTools } from "../connector-verdict.ts";
import { DraftRefused, type DraftConnection } from "../email-draft-card.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import { userError } from "../user-errors.ts";

export interface EmailDraftConnectionDeps<Access> {
  bot(botId: string): Pick<BotRecord, "name" | "composio" | "connectorScopes" | "connectorTools"> | null | undefined;
  appsConfigured(): boolean;
  /** Where each person connects Gmail themselves: the person pressing's own connection, or null when they have none.
   *  Undefined everywhere else: the workspace's connection. */
  ownAccess(auth: RequestAuth): Access | null | undefined;
  services(access: Access | undefined): Promise<readonly string[]>;
  rulesRefusal(calls: ConnectorCall[], services: readonly string[]): string | null | undefined;
  relay(access: Access | undefined, payload: unknown, transportSessionId: string | undefined, beforeSend: () => void, signal: AbortSignal):
    Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;
}

export function emailDraftConnection<Access>(deps: EmailDraftConnectionDeps<Access>) {
  return async (auth: RequestAuth, botId: string, calls: ConnectorCall[]): Promise<DraftConnection> => {
    const bot = deps.bot(botId);
    if (!bot || bot.composio === false || !deps.appsConfigured()) return { ok: false, refusal: userError("serverError.emailDraft.appsOff") };
    // The draft is only in the mailbox that saved it, so a person who connects their own Gmail uses their own.
    const own = deps.ownAccess(auth);
    if (own === null) return { ok: false, refusal: userError("serverError.emailDraft.ownGmail") };
    const services = await deps.services(own).catch(() => null);
    if (!services) return { ok: false, refusal: userError("serverError.emailDraft.appsDown") };
    // The bot read fresh against the Rules and its app permissions: now, and again right before each send (they may
    // change during the lookup).
    const refusal = () => {
      const fresh = deps.bot(botId);
      if (!fresh || fresh.composio === false || !deps.appsConfigured()) return userError("serverError.emailDraft.appsOff");
      const rules = deps.rulesRefusal(calls, services);
      if (rules) return { error: rules };
      const allowed = connectorAccessDecision(fresh.connectorScopes, calls, services).ok
        && (fresh.connectorTools === undefined || evaluateConnectorTools(calls.map((one) => one.slug), fresh.connectorTools, services).allowed);
      return allowed ? undefined : userError("serverError.emailDraft.notAllowed", { name: fresh.name });
    };
    const now = refusal();
    if (now) return { ok: false, refusal: now };
    return {
      ok: true,
      relay: (payload, session, signal) => deps.relay(own, payload, session, () => {
        const later = refusal();
        if (later) throw new DraftRefused(later);
      }, signal),
    };
  };
}
