// A chat's Sign in card for an MCP server: the connector card every client already draws, with source "mcp". The
// sign-in's owner is the card (cardOwner), so any device that can see the card may follow it and a second tap reuses the
// waiting sign-in. Its end settles the card and resumes the bot even when nobody polls. The authorization URL carries the
// OAuth state: it goes only to the client that asked for it, never into a message or a stored card.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { ConnectorCardData } from "../../shared/connector-card.ts";
import type { WireMessage as Message } from "../../shared/wire.ts";
import type { AppConfig } from "../config.ts";
import { mcpSignInCardDescription, mcpSignInCardText } from "../connector-card-text.ts";
import { cardOwner, McpOAuthError, McpSignInError, mcpCallbackOrigin, type McpOAuthManager, type McpSignInBrowser, type McpSignInPhase } from "../mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type StoredRemoteMcpServer } from "../mcp-registry.ts";
import { personKey } from "../person-key.ts";
import { isLoopbackHost, isProxied, provesSameOrigin, requestOrigin, type RequestAuth } from "../request-auth.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import { appLabel } from "../team-connections.ts";
import { runsElsewhere } from "./mcp-config.ts";

interface CardStore {
  messagesFor(threadId: string): readonly Message[];
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): unknown;
}

export interface McpSignInCardDeps {
  store: CardStore;
  cfg(): Pick<AppConfig, "mcpServers">;
  /** The sign-ins every bot uses. */
  mcpOAuth: McpOAuthManager;
  /** A Team Cloud's servers each person signs in to themselves; none off a team. */
  personal(): readonly string[];
  /** The member a chat's turns act for, whose own sign-in they mount; null off a team or in a chat others read. */
  turnPerson(threadId: string): string | null;
  oauthFor(person: string): McpOAuthManager;
  personName(person: string): string;
  /** The https addresses this home is reached at; unset ones are skipped. */
  publicOrigins(): ReadonlyArray<string | null | undefined>;
  language(threadId: string): string | undefined;
  /** Answers the turn parked on this card; false while no turn waits on it. */
  answer(threadId: string, messageId: string, text: string): boolean;
  /** A newer card replaced `from`: a turn parked on it waits on `to`. */
  followCard(threadId: string, from: string, to: string): void;
  threadVisible(auth: RequestAuth, threadId: string): boolean;
  /** A sign-in finished: whatever shows sign-in state refreshes. */
  changed(): void;
}

type McpCard = Message & { connector: ConnectorCardData };
type Reply = { status: number; body: Record<string, unknown> };
type Refusal = { status: number; error: string };
/** Why no card can sign in to a server any more, in the language asked for. */
type Unreachable = { status: number; reason(language: string | undefined): string };

const NO_CARD: Reply = { status: 404, body: { error: "no such connection request" } };
/** Why a sign-in that ended without one sends the card back to "required". A cancelled one needs no reason: it was
 * replaced, set aside, or refused before the browser opened. */
const ENDED: Partial<Record<McpSignInPhase, ServerLineKey>> = { expired: "server.mcp.signIn.expired", failed: "server.mcp.signIn.failed" };

export const isMcpSignInCard = (message: Message | undefined): message is McpCard =>
  message?.kind === "connector" && message.connector?.source === "mcp";

function cardAt(store: Pick<CardStore, "messagesFor">, owner: string): { threadId: string; card: McpCard } | null {
  if (!owner.startsWith("card:")) return null;
  const rest = owner.slice("card:".length), split = rest.lastIndexOf(":");
  if (split <= 0) return null;
  const threadId = rest.slice(0, split), messageId = rest.slice(split + 1);
  const card = store.messagesFor(threadId).find((message) => message.id === messageId);
  return isMcpSignInCard(card) ? { threadId, card } : null;
}

/** A card's sign-in stays wanted while the card is there and not set aside. */
export function isCardOwnerLive(store: Pick<CardStore, "messagesFor">, owner: string): boolean {
  const at = cardAt(store, owner);
  return Boolean(at && !at.card.connector.dismissed);
}

/** What the bot hears when the person signs in: the turn it resumes mounts the server with the new sign-in if it is on. */
const signedInText = (name: string, on: boolean) => (on
  ? `OpenMausBot MCP sign-in: the person signed in to ${name}. Its tools are yours from this turn. Continue the task that paused for this sign-in. Do not ask them to sign in again.`
  : `OpenMausBot MCP sign-in: the person signed in to ${name}, but it is off, so its tools aren't yours yet. Call mcp_server with action enable, then continue the task that paused for this sign-in. Do not ask them to sign in again.`);
const signedInUnreachableText = (name: string, reason: string) =>
  `OpenMausBot MCP sign-in: the person signed in to ${name}, but its tools aren't yours: ${reason} Continue the task that paused for this sign-in without them. Do not ask them to sign in again.`;
const notSignedInText = (name: string) => `OpenMausBot MCP sign-in for ${name}: The person didn't sign in. The server stays on but signed out.`;

export function createMcpSignInCards(deps: McpSignInCardDeps) {
  const { store } = deps;
  const find = (threadId: string, id: string): McpCard | null => {
    const message = store.messagesFor(threadId).find((row) => row.id === id);
    return isMcpSignInCard(message) ? message : null;
  };
  const patch = (threadId: string, id: string, connector: Partial<ConnectorCardData>) => {
    const card = find(threadId, id);
    if (card) store.patchMessage(threadId, id, { connector: { ...card.connector, ...connector } });
  };

  /** Whose sign-in a card makes: for a personal server the turn's person's own, else the one every bot uses. Null: a
   * personal server in a chat that is nobody's alone. */
  const signer = (name: string, threadId: string): McpOAuthManager | null => {
    if (!deps.personal().includes(name)) return deps.mcpOAuth;
    const person = deps.turnPerson(threadId);
    return person ? deps.oauthFor(person) : null;
  };

  function current(name: string): StoredRemoteMcpServer | Unreachable {
    const raw = deps.cfg().mcpServers?.[name];
    const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
    if (!parsed?.ok) return { status: 409, reason: (language) => serverLine(language, "server.mcp.card.gone", { name }) };
    const server = parsed.server;
    if (!isRemoteMcpServer(server)) return { status: 409, reason: () => "Only servers reached by URL can be signed in to." };
    const elsewhere = server.runsOn;
    if (elsewhere) return { status: 409, reason: () => runsElsewhere(elsewhere) };
    return server;
  }

  const signedInTextNow = (name: string) => {
    const server = current(name);
    return "reason" in server ? signedInUnreachableText(name, server.reason(undefined)) : signedInText(name, server.enabled);
  };

  function cancel(name: string, threadId: string, id: string): void {
    try {
      signer(name, threadId)?.cancelFlow(name, cardOwner(threadId, id));
    } catch (error) {
      if (!(error instanceof McpSignInError)) throw error;
    }
  }

  /** A shared server's sign-in becomes every bot's, so it takes an admin, as Settings does. A personal one is the turn's
   * person's own sign-in, so only they may make it. Null: this asker may; else the sentence the card shows them. */
  function mayAuthorize(auth: RequestAuth, name: string, label: string, threadId: string, language: string | undefined): string | null {
    if (!deps.personal().includes(name)) return auth.scopes.includes("admin") ? null : serverLine(language, "server.mcp.signIn.adminOnly", { label });
    const person = deps.turnPerson(threadId);
    if (person && auth.kind === "session" && personKey(auth.session) === person) return null;
    return person ? serverLine(language, "server.mcp.signIn.onlyPerson", { name: deps.personName(person) }) : serverLine(language, "server.mcp.signIn.onlyOwner");
  }

  /** Where the person's browser comes back after the provider's page: this computer's loopback listener, or this home's
   * public https address. */
  function browserFor(auth: RequestAuth, req: IncomingMessage, label: string, language: string | undefined): McpSignInBrowser | Refusal {
    if (auth.kind === "loopback" && auth.companionDevice) {
      // A phone paired to this computer reaches it only through the companion, so its browser can never reach a loopback port.
      const origin = mcpCallbackOrigin(null, deps.publicOrigins());
      return origin ? { remote: true, origin } : { status: 409, error: serverLine(language, "server.mcp.signIn.onYourMac", { label }) };
    }
    if (auth.kind !== "session" || (!isProxied(req) && isLoopbackHost(req.headers.host))) return { remote: false };
    return { remote: true, origin: mcpCallbackOrigin(provesSameOrigin(req) ? requestOrigin(req) : null, deps.publicOrigins()) };
  }

  async function authorize(auth: RequestAuth, req: IncomingMessage, threadId: string, card: McpCard): Promise<Reply> {
    const { slug: name, label } = card.connector;
    const language = deps.language(threadId);
    if (card.connector.dismissed) return { status: 409, body: { error: "This sign-in request was set aside. Ask the bot again." } };
    const denied = mayAuthorize(auth, name, label, threadId, language);
    if (denied) return { status: 409, body: { error: denied } };
    const server = current(name);
    if ("reason" in server) return unreachable(threadId, card, server);
    const browser = browserFor(auth, req, label, language);
    if ("error" in browser) return { status: browser.status, body: { error: browser.error } };
    // Paste-back needs the address bar of the browser that signed in, which only Settings asks for. A browser elsewhere
    // needs this home's https address, and a pre-registered app always comes back to a fixed loopback port.
    if (browser.remote && (!browser.origin || server.oauth)) return { status: 409, body: { error: serverLine(language, "server.mcp.signIn.inSettings") } };
    const manager = signer(name, threadId)!;
    const owner = cardOwner(threadId, card.id);
    if (browser.remote && manager.waiting(name, owner)?.loopback) cancel(name, threadId, card.id);
    let started;
    try {
      started = await manager.start(name, server.url, undefined, owner, browser);
    } catch (error) {
      if (error instanceof McpSignInError) return { status: error.status, body: { error: error.message } };
      if (error instanceof McpOAuthError) return { status: 400, body: { error: error.message, code: error.code } };
      return { status: 502, body: { error: error instanceof Error ? error.message : "Sign-in could not start." } };
    }
    // The provider refused to register this home's https address.
    if (started.pasteBack) {
      cancel(name, threadId, card.id);
      return { status: 409, body: { error: serverLine(language, "server.mcp.signIn.inSettings") } };
    }
    if (started.phase !== "waiting" || !started.authorizationUrl) return { status: 409, body: { error: "This sign-in has ended. Start again." } };
    patch(threadId, card.id, { status: "authorizing", error: undefined });
    return { status: 200, body: { url: started.authorizationUrl } };
  }

  /** A card whose server went away (removed, or no longer one a sign-in reaches) can never finish: it says why, and the
   * bot hears it once. */
  function unreachable(threadId: string, card: McpCard, server: Unreachable): Reply {
    const error = server.reason(deps.language(threadId));
    patch(threadId, card.id, { status: "failed", error });
    const said = `OpenMausBot MCP sign-in for ${card.connector.slug}: ${server.reason(undefined)} Nothing was signed in.`;
    if (!find(threadId, card.id)!.connector.resumed && deps.answer(threadId, card.id, said)) patch(threadId, card.id, { resumed: true });
    return { status: server.status, body: { error } };
  }

  /** Idempotent: a card already resumed, or one no turn waits on yet, is left as it is. False: nothing to resume. */
  function resume(threadId: string, id: string): boolean {
    const card = find(threadId, id);
    if (!card || card.connector.dismissed || card.connector.status !== "connected") return false;
    if (!card.connector.resumed && deps.answer(threadId, id, signedInTextNow(card.connector.slug))) patch(threadId, id, { resumed: true });
    return true;
  }

  function signedIn(threadId: string, id: string): void {
    const card = find(threadId, id);
    if (!card || card.connector.dismissed) return;
    if (card.connector.status !== "connected") {
      patch(threadId, id, { status: "connected", error: undefined });
      deps.changed();
    }
    resume(threadId, id);
  }

  function status(threadId: string, card: McpCard): Reply {
    const name = card.connector.slug;
    const server = current(name);
    const connected = !("reason" in server) && signer(name, threadId)?.authState(name, server.url) === "signed-in";
    if (connected) signedIn(threadId, card.id);
    // A card can say "authorizing" with no sign-in behind it: the server restarted while it waited.
    if (!connected && card.connector.status === "authorizing" && !signer(name, threadId)?.waiting(name, cardOwner(threadId, card.id))) {
      patch(threadId, card.id, { status: "required", error: serverLine(deps.language(threadId), "server.mcp.signIn.expired") });
    }
    const pending = !connected && find(threadId, card.id)?.connector.status === "authorizing";
    return { status: 200, body: { connected, pending, status: connected ? "connected" : pending ? "authorizing" : "required" } };
  }

  function dismiss(threadId: string, card: McpCard): Reply {
    patch(threadId, card.id, { dismissed: true });
    cancel(card.connector.slug, threadId, card.id);
    const now = find(threadId, card.id)!.connector;
    if (now.status !== "connected" && !now.resumed && deps.answer(threadId, card.id, notSignedInText(now.slug))) patch(threadId, card.id, { resumed: true });
    return { status: 200, body: { dismissed: true } };
  }

  return {
    /** Shows the person a Sign in card for a server the bot can't use until they sign in. An earlier open card this bot
     * showed for the same server is set aside, so the chat shows one. */
    request(at: { bot: { name: string }; threadId: string; from?: Message["from"] }, name: string, server: StoredRemoteMcpServer): { posted: true } | Refusal {
      if (!signer(name, at.threadId)) {
        return { status: 409, error: `${name} is each person's own, and this chat isn't one person's alone, so nobody can sign in to it here. Each person signs in to their own on their team's page in MausBot Cloud.` };
      }
      const replaced: string[] = [];
      for (const old of store.messagesFor(at.threadId)) {
        if (!isMcpSignInCard(old) || old.connector.slug !== name || old.from?.botId !== at.from?.botId) continue;
        if (old.connector.dismissed || old.connector.stopped || old.connector.status === "connected") continue;
        patch(at.threadId, old.id, { dismissed: true, superseded: true });
        cancel(name, at.threadId, old.id);
        replaced.push(old.id);
      }
      const language = deps.language(at.threadId), label = appLabel(name);
      const card = store.appendMessage(at.threadId, {
        role: "bot", kind: "connector", text: mcpSignInCardText(label, language),
        ...(at.from ? { from: at.from } : {}),
        connector: {
          source: "mcp", slug: name, label, status: "required", resumeKey: `mcp-${randomUUID()}`,
          description: mcpSignInCardDescription(at.bot.name, label, new URL(server.url).host, language),
        },
      });
      for (const old of replaced) deps.followCard(at.threadId, old, card.id);
      return { posted: true };
    },

    /** The card's authorize, status, resume and dismiss, as the connector-card routes take them. */
    async route(action: string, method: string, at: { auth: RequestAuth; req: IncomingMessage; threadId: string; message: Message }): Promise<Reply> {
      const card = at.message;
      if (!isMcpSignInCard(card) || !deps.threadVisible(at.auth, at.threadId)) return NO_CARD;
      if (action === "authorize" && method === "POST") return authorize(at.auth, at.req, at.threadId, card);
      if (action === "status" && method === "GET") return status(at.threadId, card);
      if (action === "resume" && method === "POST") {
        return resume(at.threadId, card.id) ? { status: 200, body: { resumed: true } } : { status: 409, body: { error: "finish signing in first" } };
      }
      if (action === "dismiss" && method === "POST") return dismiss(at.threadId, card);
      return { status: 405, body: { error: "method not allowed" } };
    },

    /** McpOAuthManager's onSettled: a card's sign-in ended. */
    settled(name: string, phase: McpSignInPhase, owner: string): void {
      const at = cardAt(store, owner);
      if (!at || at.card.connector.slug !== name || at.card.connector.dismissed) return;
      if (phase === "succeeded") return signedIn(at.threadId, at.card.id);
      if (phase === "waiting" || at.card.connector.status === "connected") return;
      const reason = ENDED[phase];
      patch(at.threadId, at.card.id, { status: "required", error: reason ? serverLine(deps.language(at.threadId), reason) : undefined });
    },

    /** What a turn that parked after the person already answered the card hears; null while there is nothing to hear. */
    parkedAnswer(card: ConnectorCardData): string | null {
      if (card.superseded || card.resumed) return null;
      if (card.status === "connected") return signedInTextNow(card.slug);
      return card.dismissed ? notSignedInText(card.slug) : null;
    },
  };
}

export type McpSignInCards = ReturnType<typeof createMcpSignInCards>;
