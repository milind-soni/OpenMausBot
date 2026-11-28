// The connection a draft card's Save runs through: the bot's connected apps, as the person pressing, checked against the
// Rules and the bot's app permissions. index.ts builds it once and hands it what it needs.
import { connectorAccessDecision, type ConnectorScopes } from "../shared/connector-scopes.ts";
import type { ConnectorCall } from "../shared/outbound.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";
import * as composio from "./composio.ts";
import type { AppConfig } from "./config.ts";
import { evaluateConnectorTools } from "./connector-verdict.ts";
import { DraftRefused, type DraftConnection } from "./email-draft-card.ts";
import type { createTeamConnectionsHost } from "./host/team-connections-host.ts";
import type { ManagedDesktopPolicy } from "./managed-policy.ts";
import type { RequestAuth } from "./request-auth.ts";
import { userError } from "./user-errors.ts";

type Bot = { name: string; composio?: boolean; connectorTools?: Record<string, ConnectorToolGrant>; connectorScopes?: ConnectorScopes };

export interface DraftConnectionDeps {
  bot(id: string): Bot | null | undefined;
  cfg(): AppConfig;
  teamConnections: Pick<ReturnType<typeof createTeamConnectionsHost>, "personApps" | "people" | "via">;
  rules: Pick<ManagedDesktopPolicy, "appsCallRefusal">;
  /** The signed-in person's key, for their own app connections. */
  person(auth: RequestAuth & { kind: "session" }): string;
}

export function createDraftConnection(deps: DraftConnectionDeps): (auth: RequestAuth, botId: string, calls: ConnectorCall[]) => Promise<DraftConnection> {
  const appsOn = (bot: Bot | null | undefined): bot is Bot => Boolean(bot) && bot!.composio !== false && composio.configured(deps.cfg());
  return async (auth, botId, calls) => {
    if (!appsOn(deps.bot(botId))) return { ok: false, refusal: userError("serverError.emailDraft.appsOff") };
    const { teamConnections } = deps;
    // Where each person connects Gmail themselves, the person pressing uses their own; the draft is only in the mailbox that saved it.
    const own = teamConnections.personApps().includes("gmail") ? (auth.kind === "session" ? teamConnections.people.appsAccess(deps.person(auth)) : null) : undefined;
    if (own === null) return { ok: false, refusal: userError("serverError.emailDraft.ownGmail") };
    const via = teamConnections.via(own);
    const services = await composio.connectedServiceSlugs(...via).catch(() => null);
    if (!services) return { ok: false, refusal: userError("serverError.emailDraft.appsDown") };
    // The bot read fresh against the Rules and its app permissions: now, and again right before the call goes out (they
    // may change during the lookup), after the card's own check of the person.
    const refusal = () => {
      const fresh = deps.bot(botId);
      if (!appsOn(fresh)) return userError("serverError.emailDraft.appsOff");
      const rules = deps.rules.appsCallRefusal(calls, services);
      if (rules) return { error: rules };
      const allowed = connectorAccessDecision(fresh.connectorScopes, calls, services).ok
        && (fresh.connectorTools === undefined || evaluateConnectorTools(calls.map((one) => one.slug), fresh.connectorTools, services).allowed);
      return allowed ? undefined : userError("serverError.emailDraft.notAllowed", { name: fresh.name });
    };
    const now = refusal();
    if (now) return { ok: false, refusal: now };
    return {
      ok: true,
      relay: (payload, session, signal, beforeSend) => composio.relayMcp(via[0], payload as never, session, () => {
        beforeSend?.();
        const later = refusal();
        if (later) throw new DraftRefused(later);
      }, signal, via[1]),
    };
  };
}
