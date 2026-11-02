// Asking to chat with a team bot one can only view: POST /api/bots/<id>/access-request puts an Allow / Not now card in
// the inbox of the bot's owner (or of each admin, when nobody owns it). Allow gives the asker Can chat at once and tells
// them in their own inbox. Security: the route is client-scoped and the gate lets anyone who can view the bot reach it;
// the card's answer takes effect only while the person answering can edit the bot.
import { randomUUID } from "node:crypto";

import { ACCESS_REQUEST_OPTIONS, atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import { botOwner, nameFromEmail } from "../../shared/bot-owner.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { accessOf, type Viewer, type VisibleSet } from "../bot-visibility.ts";
import type { CloudTeam, TeamRole } from "../cloud-team.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";
import type { Delivery } from "./person-inbox.ts";

const ONE_BOT = /^\/api\/bots\/([\w-]{1,128})\/access-request$/;

export interface AccessRequestDeps {
  team: CloudTeam | null;
  /** index.ts's store, made after this host. */
  store(): Pick<Store, "bot" | "messagesFor" | "patchMessage">;
  /** The team's current members. */
  people(): ReadonlyArray<{ email: string; role: TeamRole }>;
  /** The name a member chose, when they chose one. */
  profileName(email: string): string | undefined;
  /** Every person's inbox, made after this host. */
  inbox(): {
    deliver(person: string, delivery: Delivery): { threadId: string } | null;
    personOf(threadId: string): string | null;
    home(person: string): { threadId: string } | null | undefined;
  };
  visibleTo(viewer: Viewer): VisibleSet;
  levelOf(auth: RequestAuth, botId: string): BotAccessLevel;
  writeAccess(bot: BotRecord, access: ReturnType<typeof accessOf>): BotRecord | null;
}

export function createAccessRequests(deps: AccessRequestDeps) {
  const personKeyOf = (email: string) => personKey({ id: "", email });
  const nameOf = (email: string) => deps.profileName(email)?.trim() || nameFromEmail(email);
  const levelFor = (person: { email: string; role: TeamRole }, botId: string) =>
    deps.visibleTo(person.role === "member" ? { kind: "member", email: person.email } : { kind: "all", email: person.email }).level(botId);
  const sessionEmail = (auth: RequestAuth) => auth.kind === "session" && auth.session.membershipAuthority === "team" ? auth.session.email?.trim().toLowerCase() ?? null : null;

  /** Who decides: the bot's owner while they are on the team, else every admin. */
  function deciders(bot: BotRecord): Array<{ email: string; role: TeamRole }> {
    const people = deps.people();
    const owner = botOwner(bot);
    const theirs = owner ? people.find((person) => person.email === owner) : undefined;
    return theirs ? [theirs] : people.filter((person) => person.role !== "member");
  }

  /** The open asks for this bot from this person, in the inbox of each admin and of the bot's owner. */
  function openAsks(bot: BotRecord, email: string) {
    const owner = botOwner(bot);
    return deps.people().filter((person) => person.role !== "member" || person.email === owner).flatMap((person) => {
      const home = deps.inbox().home(personKeyOf(person.email));
      const line = home ? deps.store().messagesFor(home.threadId).find((message) =>
        message.card?.accessRequest?.botId === bot.id && message.card.accessRequest.email === email && !message.card.answered && !message.card.dismissed) : undefined;
      return home && line ? [{ person, threadId: home.threadId, line }] : [];
    });
  }

  const routes: RouteHandler = async ({ res, path, method, auth, json }) => {
    const one = method === "POST" ? ONE_BOT.exec(path) : null;
    if (!one) return PASS;
    const bot = deps.store().bot(one[1]!);
    const email = sessionEmail(auth);
    if (!deps.team || !bot || !email) return json(res, 404, { error: "no such bot" });
    if (deps.levelOf(auth, bot.id) !== "view") return json(res, 409, { error: `You can already chat with ${bot.name}.` });
    const asked = openAsks(bot, email);
    if (asked.length) return json(res, 200, { asked: asked.map(({ person }) => ({ email: person.email, name: nameOf(person.email) })) });
    const name = nameOf(email);
    const card: OptionCardData = {
      title: `${name} asks to chat with ${bot.name}`,
      subtitle: `${name} can view ${bot.name}. Allow lets them chat with it and start their own conversations.`,
      options: [...ACCESS_REQUEST_OPTIONS], fixedOptions: true, requestType: "question",
      accessRequest: { botId: bot.id, botName: bot.name, email, name },
    };
    const reached = deciders(bot).filter((person) => deps.inbox().deliver(personKeyOf(person.email), {
      kind: "ask", from: { name, email }, text: card.subtitle, title: card.title, notify: "question", card: { ...card, requestId: `access-${randomUUID()}` },
    }));
    if (!reached.length) return json(res, 409, { error: `Nobody who can let you in has an inbox here yet. Ask an admin of ${deps.team.name}.` });
    return json(res, 201, { asked: reached.map((person) => ({ email: person.email, name: nameOf(person.email) })) });
  };

  /** Answers one of these cards, and the same ask in every other inbox; null for any other card. The person answering
   * is the inbox's own. */
  function resolve(threadId: string, requestId: string, behavior: string, message: unknown): { status: number; body: unknown } | null {
    const line = deps.store().messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId && candidate.card.accessRequest);
    const ask = line?.card?.accessRequest;
    if (!line?.card || !ask) return null;
    if (line.card.answered || line.card.dismissed) return { status: 409, body: { error: "This has already been answered." } };
    const allow = behavior === "allow" || (behavior === "answer" && message === ACCESS_REQUEST_OPTIONS[0]);
    const decider = deps.inbox().personOf(threadId);
    const person = deps.people().find((one) => personKeyOf(one.email) === decider);
    const bot = deps.store().bot(ask.botId);
    if (allow) {
      if (!bot || !person || levelFor(person, bot.id) !== "edit") return { status: 403, body: { error: `Only people who can edit ${ask.botName} can let someone chat with it.` } };
      const access = accessOf(bot);
      if (!atLeast(access.people[ask.email], "chat")) deps.writeAccess(bot, { everyone: access.everyone, people: { ...access.people, [ask.email]: "chat" } });
      deps.inbox().deliver(personKeyOf(ask.email), {
        kind: "notice", from: { name: nameOf(person.email), email: person.email },
        text: `${nameOf(person.email)} let you chat with ${bot.name}.`, title: `You can chat with ${bot.name}`, notify: "done",
      });
    }
    for (const open of [{ threadId, line }, ...(bot ? openAsks(bot, ask.email).filter((other) => other.threadId !== threadId) : [])]) {
      deps.store().patchMessage(open.threadId, open.line.id, { card: { ...open.line.card!, answered: "answer", answeredText: allow ? ACCESS_REQUEST_OPTIONS[0] : ACCESS_REQUEST_OPTIONS[1] } });
    }
    return { status: 200, body: { ok: true, outcome: allow ? "allowed" : "declined" } };
  }

  return { routes, resolve };
}
