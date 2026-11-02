// Security: on a Team Cloud what a member may do with a bot is its level (shared/bot-access.ts): viewing reads, chatting
// writes, editing changes its setup. Seeing at all is the visibility gate's (404 for a bot they cannot see); this is the
// second check every member request passes, on the bot its path names, the bot of the conversation it names, and every
// bot of a room. Admins pass: they can edit every bot.
import type { IncomingMessage } from "node:http";

import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import { bodyThreadIds, memberLevel, pathSubject, type AccessBot, type ThreadOwner, type VisibleSet } from "../bot-visibility.ts";
import { onParsedBody } from "../harness/http.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { Store } from "../store.ts";

type Target = { botId?: unknown; groupId?: unknown };

export interface BotAccessGateDeps {
  botName(botId: string): string | undefined;
  roomBots(groupId: string): readonly string[] | undefined;
  threadOwner(threadId: string): ThreadOwner | undefined;
  routine(id: string): Target | undefined;
  run(id: string): Target | undefined;
  /** The person key of whoever last wrote the routine. */
  routineWriter(id: string): string | undefined;
}

const OPEN_CONVERSATION = /^\/api\/(?:bots|groups)\/[\w-]+\/tasks\/(?!delete$)[\w-]+$/;

/** What a member needs on what a request's path names; null where the route weighs the request itself (a bot's own
 * PATCH, which checks each field, and a routine, which its own writer may still change). */
export function levelNeeded(method: string, path: string): Exclude<BotAccessLevel, "none"> | null {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return "view";
  if (/^\/api\/bots\/[\w-]+$/.test(path)) return null;
  if (/^\/api\/bots\/[\w-]+\/access$/.test(path)) return "edit";
  if (/^\/api\/routines\/[\w-]+$/.test(path)) return null;
  if (/^\/api\/(?:bots|groups)\/[\w-]+\/read$/.test(path) || /^\/api\/bots\/[\w-]+\/access-request$/.test(path)) return "view";
  if (verb === "POST" && OPEN_CONVERSATION.test(path)) return "view";
  if (/^\/api\/routine-runs\/[\w-]+\/seen$/.test(path)) return "view";
  return "chat";
}

export function refusalFor(name: string, needed: BotAccessLevel): string {
  return needed === "edit" ? `Only people who can edit ${name} can change this.` : `You can view ${name}, not chat with it.`;
}

export function createBotAccessGate(deps: BotAccessGateDeps) {
  const ownerBots = (owner: ThreadOwner | undefined): readonly string[] =>
    owner?.bot !== undefined ? [owner.bot] : owner?.group !== undefined ? deps.roomBots(owner.group) ?? [] : [];
  const targetBots = (target: Target | undefined): readonly string[] =>
    typeof target?.groupId === "string" && target.groupId ? deps.roomBots(target.groupId) ?? []
      : typeof target?.botId === "string" ? [target.botId] : [];

  /** The first of these bots the member sees but may not do this with. A bot they cannot see is the visibility gate's. */
  function short(visible: VisibleSet, botIds: readonly string[], needed: BotAccessLevel): string | null {
    for (const id of botIds) {
      const level = visible.level(id);
      if (level !== "none" && !atLeast(level, needed)) return refusalFor(deps.botName(id) ?? "this bot", needed);
    }
    return null;
  }

  /** Null to let the request through; else why a member may not. Body fields are checked as the route reads them. */
  return function accessRefusal(req: IncomingMessage, auth: RequestAuth, method: string, path: string, visible: VisibleSet): string | null {
    if (auth.kind !== "session" || !visible.member || !visible.filtersThreads) return null;
    const needed = levelNeeded(method, path);
    const subject = pathSubject(path);
    const named = !subject ? [] : subject.kind === "bot" ? [subject.id] : subject.kind === "thread" ? ownerBots(deps.threadOwner(subject.id))
      : subject.kind === "group" ? deps.roomBots(subject.id) ?? [] : subject.kind === "routine" ? targetBots(deps.routine(subject.id))
        : subject.kind === "routine-run" ? targetBots(deps.run(subject.id)) : [];
    const routine = subject?.kind === "routine" && needed === null ? subject.id : null;
    const own = routine !== null && deps.routineWriter(routine) === personKey(auth.session);
    const refused = needed ? short(visible, named, needed) : routine !== null ? short(visible, named, own ? "chat" : "edit") : null;
    if (refused) return refused;
    if (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") return null;
    const bodyNeeds = needed ?? "chat";
    onParsedBody(req, (body) => {
      const record = body && typeof body === "object" && !Array.isArray(body) ? body as Target & { memberIds?: unknown } : {};
      const added = path === "/api/groups" && Array.isArray(record.memberIds) ? record.memberIds.filter((id): id is string => typeof id === "string") : [];
      const targeted = path === "/api/routines" || routine !== null ? targetBots(record) : [];
      const threads = bodyThreadIds(body).flatMap((threadId) => ownerBots(deps.threadOwner(threadId)));
      const error = short(visible, [...added, ...targeted, ...threads], bodyNeeds);
      return error ? { status: 403, error } : null;
    });
    return null;
  };
}

type SetupCard = { profileRequest?: unknown; modelRequest?: unknown; skillRequest?: unknown; teamSetupRequest?: unknown; webhookRequest?: unknown; appTriggerRequest?: unknown };

/** A card whose answer changes the bot itself (its instructions, model, skills, team, triggers) is answered only by
 * someone who can edit it; any other card by whoever may answer it. */
export function setupCardRefusal(card: SetupCard | undefined, bot: { id: string; name: string } | undefined, level: (botId: string) => BotAccessLevel): string | null {
  if (!card || !bot) return null;
  const changesBot = card.profileRequest !== undefined || card.modelRequest !== undefined || card.skillRequest !== undefined ||
    card.teamSetupRequest !== undefined || card.webhookRequest !== undefined || card.appTriggerRequest !== undefined;
  return changesBot && !atLeast(level(bot.id), "edit") ? refusalFor(bot.name, "edit") : null;
}

/** A message another app relays for a person (the guarded route's onBehalfOf) needs that person to be able to chat with
 * the bot; one that names nobody is anyone in the team, so it needs everyone to be able to. */
export function relayedSendRefusal(bot: AccessBot & { name: string }, email: string | undefined, admin: boolean): string | null {
  if (admin || atLeast(memberLevel(bot, email), "chat")) return null;
  return `${email ?? "Someone outside the people added"} can't chat with ${bot.name} here.`;
}

export interface BotAccessHostDeps {
  visibleFor(auth: RequestAuth): VisibleSet;
  /** index.ts's store, made after this host. */
  store(): Pick<Store, "bot" | "group" | "botByThread" | "messagesFor">;
  routines(): Pick<RoutineManager, "listRoutines" | "listRuns"> | null;
  threadOwner(threadId: string): ThreadOwner | undefined;
  routineWriter(id: string): string | undefined;
}

/** What index.ts asks of levels: a session's level on a bot, the request gate, and the check a card's answer passes. */
export function createBotAccessHost(deps: BotAccessHostDeps) {
  const levelOf = (auth: RequestAuth, botId: string): BotAccessLevel => deps.visibleFor(auth).level(botId);
  const accessRefusal = createBotAccessGate({
    botName: (id) => deps.store().bot(id)?.name,
    roomBots: (id) => deps.store().group(id)?.memberIds,
    threadOwner: deps.threadOwner,
    routine: (id) => deps.routines()?.listRoutines().find((one) => one.id === id),
    run: (id) => deps.routines()?.listRuns().find((one) => one.id === id),
    routineWriter: deps.routineWriter,
  });
  function cardRefusal(auth: RequestAuth, threadId: string, requestId: string): string | null {
    const store = deps.store();
    const line = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
    if (!line?.card) return null;
    return setupCardRefusal(line.card, store.bot(line.from?.botId ?? "") ?? store.botByThread(threadId) ?? undefined, (botId) => levelOf(auth, botId));
  }
  return { levelOf, accessRefusal, cardRefusal };
}
