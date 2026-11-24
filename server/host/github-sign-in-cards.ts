// A chat's Connect GitHub card: the connector card every client already draws, with source "github". It is shown only
// after a clone, fetch or push failed because GitHub isn't connected (raise), never ahead of one. The card's client signs
// in through the GitHub sign-in routes; here a card is settled, set aside, or refused an app authorize from a client
// that does not know it.
import { randomUUID } from "node:crypto";

import type { ConnectorCardData } from "../../shared/connector-card.ts";
import type { WireMessage as Message } from "../../shared/wire.ts";
import type { GithubSignIn } from "../github/sign-in.ts";
import type { RequestAuth } from "../request-auth.ts";
import { githubAudience } from "../routes/github-sign-in.ts";
import { serverLine } from "../server-lines.ts";

/** The card's slug: never an app's, so nothing that settles an app's connect cards touches it. */
export const GITHUB_CARD_SLUG = "github-sign-in";
const OWNER = "owner";
/** After a card is shown or set aside, no other is shown to that person for this long, in any chat. */
export const GITHUB_CARD_COOLDOWN_MS = 60 * 60_000;
/** owner/repo as GitHub allows it: the text is the bot's, so nothing else reaches the card. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;

export type GithubGitOperation = "clone" | "fetch" | "push";

/** What failed: the git operation, the repository, and whether GitHub refused the saved sign-in (its 401). */
export interface GithubSignInFailure {
  operation: GithubGitOperation;
  repo: string;
  refused?: boolean;
}

export type GithubCardRaised =
  | { posted: true; messageId: string }
  /** signed-in: the failure was not for want of a sign-in. signing-in: the person is already at it. no-person: a Team
   * Cloud chat that is not one member's alone. open: this chat already shows one, which stays. */
  | { posted: false; reason: "invalid-repo" | "invalid-operation" | "no-person" | "cooldown" | "signed-in" | "signing-in" | "open"; messageId?: string };

interface CardStore {
  messagesFor(threadId: string): readonly Message[];
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): unknown;
}

export interface GithubSignInCardDeps {
  store: CardStore;
  signIn: Pick<GithubSignIn, "status" | "reportAuthFailure">;
  /** A Team Cloud: each member signs in for themselves. */
  team: boolean;
  /** On a Team Cloud, the member a chat's turns act for, in their own private chat; null anywhere else. */
  turnPerson(threadId: string, generation?: string): string | null;
  language(threadId: string): string | undefined;
  threadVisible(auth: RequestAuth, threadId: string): boolean;
  /** GitHub got connected: a turn parked on this card, if any, carries on. */
  resume(threadId: string, resumeKey: string): void;
  /** The card was set aside: a turn parked on it stops waiting. */
  release(threadId: string, messageId: string): void;
  now?: () => number;
}

type GithubCard = Message & { connector: ConnectorCardData };
type Reply = { status: number; body: Record<string, unknown> };

export const isGithubSignInCard = (message: Message | undefined): message is GithubCard =>
  message?.kind === "connector" && message.connector?.source === "github";

const LINE = { clone: "server.github.card.clone", fetch: "server.github.card.fetch", push: "server.github.card.push" } as const;

export function createGithubSignInCards(deps: GithubSignInCardDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  /** When each person was last shown a card, or set one aside. */
  const lastShown = new Map<string, number>();
  const audienceOf = (threadId: string, generation?: string): string | null => (deps.team ? deps.turnPerson(threadId, generation) : OWNER);
  /** Whose sign-in a card asks for: the person it was raised for, never whoever the chat's turns act for now. */
  const cardAudience = (card: GithubCard): string | null => (deps.team ? card.connector.person ?? null : OWNER);
  const open = (threadId: string, botId: string | undefined) => store.messagesFor(threadId).find((message): message is GithubCard =>
    isGithubSignInCard(message) && (message.from?.botId ?? null) === (botId ?? null)
    && !message.connector.dismissed && !message.connector.stopped && message.connector.status !== "connected");

  return {
    /** After a clone, fetch or push failed for want of a GitHub sign-in: shows the person a Connect GitHub card where the
     * work stopped, unless the sign-in is there after all, one is under way, or this chat already shows the card. */
    async raise(at: { bot: { id: string; name: string }; threadId: string; generation?: string; from?: Message["from"] }, failure: GithubSignInFailure): Promise<GithubCardRaised> {
      if (!Object.hasOwn(LINE, failure.operation)) return { posted: false, reason: "invalid-operation" };
      if (typeof failure.repo !== "string" || !REPO.test(failure.repo)) return { posted: false, reason: "invalid-repo" };
      const audience = audienceOf(at.threadId, at.generation);
      if (!audience) return { posted: false, reason: "no-person" };
      if (failure.refused) deps.signIn.reportAuthFailure(audience);
      const shown = open(at.threadId, at.from?.botId);
      if (shown) return { posted: false, reason: "open", messageId: shown.id };
      const last = lastShown.get(audience);
      if (last !== undefined && now() - last < GITHUB_CARD_COOLDOWN_MS) return { posted: false, reason: "cooldown" };
      const signIn = await deps.signIn.status(audience);
      if (signIn.state === "signed-in") return { posted: false, reason: "signed-in" };
      if (signIn.state === "installing" || signIn.state === "signing-in") return { posted: false, reason: "signing-in" };
      const again = lastShown.get(audience);
      if (again !== undefined && now() - again < GITHUB_CARD_COOLDOWN_MS) return { posted: false, reason: "cooldown" };
      lastShown.set(audience, now());
      const language = deps.language(at.threadId);
      const message = store.appendMessage(at.threadId, {
        role: "bot", kind: "connector",
        text: serverLine(language, LINE[failure.operation], { bot: at.bot.name, repo: failure.repo }),
        ...(at.from ? { from: at.from } : {}),
        connector: {
          source: "github", slug: GITHUB_CARD_SLUG, label: "GitHub", status: "required", resumeKey: `github-${randomUUID()}`,
          ...(deps.team ? { person: audience } : {}),
          description: serverLine(language, "server.github.card.description", { bot: at.bot.name }),
        },
      });
      return { posted: true, messageId: message.id };
    },

    /** The connector-card routes for this card. Its own person only: on a Team Cloud another member's sign-in is never
     * read or reported here. */
    async route(action: string, method: string, at: { auth: RequestAuth; threadId: string; message: Message }): Promise<Reply> {
      const card = at.message;
      if (!isGithubSignInCard(card) || !deps.threadVisible(at.auth, at.threadId)) return { status: 404, body: { error: "no such connection request" } };
      if (action === "dismiss" && method === "POST") {
        store.patchMessage(at.threadId, card.id, { connector: { ...card.connector, dismissed: true } });
        const person = cardAudience(card);
        if (person) lastShown.set(person, now());
        deps.release(at.threadId, card.id);
        return { status: 200, body: { dismissed: true } };
      }
      if (action === "authorize" && method === "POST") return { status: 409, body: { error: serverLine(deps.language(at.threadId), "server.github.card.connectInApps") } };
      if (action === "resume" && method === "POST") return { status: 409, body: { error: "nothing waits on this card" } };
      if (action !== "status" || method !== "GET") return { status: 405, body: { error: "method not allowed" } };
      const audience = cardAudience(card);
      if (!audience || githubAudience(at.auth, deps.team) !== audience) return { status: 403, body: { error: "This GitHub sign-in is someone else's." } };
      const signIn = await deps.signIn.status(audience);
      const connected = signIn.state === "signed-in";
      if (connected && card.connector.status !== "connected") {
        store.patchMessage(at.threadId, card.id, { connector: { ...card.connector, status: "connected", error: undefined } });
        deps.resume(at.threadId, card.connector.resumeKey);
      }
      const pending = signIn.state === "installing" || signIn.state === "signing-in";
      return { status: 200, body: { connected, pending, status: connected ? "connected" : pending ? "authorizing" : "required" } };
    },
  };
}

export type GithubSignInCards = ReturnType<typeof createGithubSignInCards>;
