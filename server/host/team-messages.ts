// A Team Cloud's people as people a bot can name. A teammate tagged with @Name in a conversation they can see gets a
// notification and a Needs you line of their own, nobody else. message_person ("tell Bob that…") passes one message
// to one teammate: into the conversation they can see, or a new private conversation between them and the same bot,
// whose answer can come back to the conversation that asked. Only the message travels: a turn still reads only its own
// audience (audience.ts). Off a team nothing here exists. The state is ids, names and short excerpts, in
// team-messages.json.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";

import { nameFromEmail, ownerEmail } from "../../shared/bot-owner.ts";
import type { Notification } from "../../shared/notification.ts";
import { mentionablePeople, teammateMentions } from "../../shared/person-mention.ts";
import type { NeedsYouItem } from "../../shared/today.ts";
import { writeFileAtomic } from "../atomic.ts";
import { audienceMember, type Audience } from "../audience.ts";
import type { CloudTeam, TeamRole } from "../cloud-team.ts";
import type { json as sendJson } from "../harness/http.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS } from "../routes/table.ts";
import type { BotRecord, GroupRecord, Message, Store, StoreChange } from "../store.ts";
import type { TeamPeople } from "../team-people.ts";
import { oneLine } from "./text-clip.ts";

export const TEAM_MESSAGES_FILE = "team-messages.json";
export const MESSAGE_PERSON_PATH = "/api/internal/people/message";
export const MESSAGE_PERSON_MAX = 2_000;
/** Passes from one conversation in an hour: enough for a person's errands, too few for two bots to ping-pong for long. */
export const MESSAGE_PERSON_HOURLY = 10;
const HOUR_MS = 60 * 60_000;
const WAITING_MS = 7 * 24 * HOUR_MS;
const MAX_WAITING = 1_000;
const MAX_RELAYS = 2_000;
const MAX_HANDLED_TURNS = 2_000;
const PROMPT_PEOPLE = 30;

const id = z.string().min(1).max(200);
const person = z.string().regex(/^p_[\w-]{22}$/u);
const name = z.string().max(200);
const relaySchema = z.object({ threadId: id, botId: id, originThreadId: id, from: person.nullable(), fromName: name, to: person, at: z.number() });
const waitingSchema = z.object({ id, person, botId: id, threadId: id, messageId: id.optional(), from: name, fromEmail: z.string().max(320).optional(), text: z.string().max(400), at: z.number() });
const fileSchema = z.object({ version: z.literal(1), relays: z.array(relaySchema).max(MAX_RELAYS), waiting: z.array(waitingSchema).max(MAX_WAITING) });
const bodySchema = z.object({ to: z.string().trim().min(1).max(254), message: z.string().trim().min(1).max(MESSAGE_PERSON_MAX) }).strict();

/** A conversation message_person made: who asked, from where, and for whom. */
type Relay = z.infer<typeof relaySchema>;
type Waiting = z.infer<typeof waitingSchema>;
type Person = { email: string; role: TeamRole; key: string; name: string; left: boolean };
type Where = { bot: BotRecord; group?: GroupRecord };
type Passed = { status: number; text: string };

export interface TeamMessagesDeps {
  team: CloudTeam | null;
  dataDir: string;
  store: Pick<Store, "bot" | "bots" | "botByThread" | "groupByThread" | "taskByThread" | "createTask" | "appendMessage" | "patchTask" | "patchGroup" | "activePath" | "onChange">;
  people: Pick<TeamPeople, "everyone"> | null;
  /** The name a member chose on this team, by their person key; their address or nothing when they chose none. */
  personName(person: string): string | undefined;
  audienceOf(threadId: string): Audience;
  starters: { set(threadId: string, person: string): void };
  /** What one person may see, as their own session would. */
  sees(person: { email: string; role: TeamRole }): { bot(botId: string): boolean; thread(threadId: string): boolean };
  notify(notification: Notification): void;
  now?: () => number;
}

export interface MessagePersonContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

const keyOf = (email: string) => personKey({ id: "", email });

export function createTeamMessages(deps: TeamMessagesDeps) {
  const team = deps.team;
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, TEAM_MESSAGES_FILE);
  let relays: Relay[] = [];
  let waiting: Waiting[] = [];
  if (team) {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) ({ relays, waiting } = parsed.data);
      else console.warn(`team messages: ${file} is not a messages file; starting fresh`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`team messages: ${file} is unreadable; starting fresh`);
    }
  }

  const nameOf = (email: string, key: string) => {
    const chosen = deps.personName(key)?.trim();
    return chosen && chosen !== email ? chosen : nameFromEmail(email);
  };
  const everyone = (): Person[] => (deps.people?.everyone() ?? []).map((one) => {
    const key = keyOf(one.email);
    return { email: one.email, role: one.role, key, name: nameOf(one.email, key), left: one.leftAt !== undefined };
  });
  const current = () => everyone().filter((one) => !one.left).sort((a, b) => a.name.localeCompare(b.name));
  const byKey = (key: string | null | undefined) => (key ? current().find((one) => one.key === key) : undefined);

  const save = () => {
    const here = new Set(current().map((one) => one.key));
    waiting = waiting.filter((item) => here.has(item.person) && now() - item.at < WAITING_MS).slice(-MAX_WAITING);
    relays = relays.filter((relay) => here.has(relay.to)).slice(-MAX_RELAYS);
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, relays, waiting })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`team messages: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The bot speaks in this conversation: its own chat, one of its threads, or a group chat it is in. */
  function where(botId: string, threadId: string): Where | null {
    const bot = store.bot(botId);
    if (!bot) return null;
    if (bot.threadId === threadId || store.taskByThread(botId, threadId)) return { bot };
    const group = store.groupByThread(threadId);
    return group?.memberIds.includes(botId) ? { bot, group } : null;
  }

  /** Who a turn here speaks for: a private chat's own person, else whoever wrote in it last. */
  function askerOf(threadId: string): Person | undefined {
    const member = audienceMember(deps.audienceOf(threadId));
    if (member) return byKey(member);
    return byKey(store.activePath(threadId).findLast((message) => message.role === "user" && !message.peerAsk && message.sender?.id)?.sender?.id);
  }

  /** A teammate by name or address. Someone who left is found too, so the refusal can say so. */
  function resolve(raw: string): { person: Person } | { status: number; error: string } {
    const wanted = raw.replace(/^@+/, "").replace(/\s+/g, " ").trim();
    const folded = wanted.toLowerCase();
    const all = everyone();
    const pick = (test: (one: Person) => boolean) => {
      const hits = all.filter(test);
      return hits.some((one) => !one.left) ? hits.filter((one) => !one.left) : hits;
    };
    let hits = folded.includes("@") ? pick((one) => one.email === ownerEmail(wanted)) : [];
    if (!hits.length) hits = pick((one) => one.name.toLowerCase() === folded);
    if (!hits.length) hits = pick((one) => one.name.toLowerCase().split(" ")[0] === folded);
    if (!hits.length) hits = pick((one) => one.email.split("@")[0] === folded);
    if (!hits.length) {
      const names = current().map((one) => one.name).join(", ");
      return { status: 404, error: `Nobody called "${wanted}" is in ${team!.name}.${names ? ` The people here: ${names}.` : ""}` };
    }
    if (hits.length > 1) return { status: 409, error: `More than one person here is called "${wanted}": ${hits.map((one) => `${one.name} (${one.email})`).join(", ")}. Say which one by email.` };
    if (hits[0]!.left) return { status: 410, error: `${hits[0]!.name} has left ${team!.name}, so nothing can be passed to them any more. Tell the person.` };
    return { person: hits[0]! };
  }

  const passes = new Map<string, number[]>();
  const recent = (threadId: string) => (passes.get(threadId) ?? []).filter((at) => now() - at < HOUR_MS);
  const spend = (threadId: string) => passes.set(threadId, [...recent(threadId), now()]);

  const from = (bot: BotRecord) => ({ botId: bot.id, name: bot.name, color: bot.color });
  const markUnread = (botId: string, threadId: string, group: GroupRecord | undefined) => {
    if (group) store.patchGroup(group.id, { unread: true });
    else store.patchTask(botId, threadId, { unread: true });
  };

  /** The persons notified during the turn now running in a conversation: its settled reply does not tell them again. */
  const toldThisTurn = new Map<string, Set<string>>();

  /** One notification and one Needs you line for one person, opening `messageId`. */
  function tell(to: Person, input: { where: Where; threadId: string; messageId?: string; title: string; from: string; fromPerson?: Person; text: string }) {
    const { bot, group } = input.where;
    deps.notify({
      kind: "mention", botId: bot.id, botName: bot.name, threadId: input.threadId, title: input.title, body: oneLine(input.text, 200),
      forPerson: to.key, ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}), ...(group ? { groupId: group.id } : {}),
    });
    waiting = [...waiting.filter((item) => !(item.person === to.key && item.threadId === input.threadId)), {
      id: randomUUID(), person: to.key, botId: bot.id, threadId: input.threadId, ...(input.messageId ? { messageId: input.messageId } : {}),
      from: input.from.slice(0, 200), ...(input.fromPerson ? { fromEmail: input.fromPerson.email } : {}), text: oneLine(input.text, 300), at: now(),
    }];
    save();
  }

  /** "Told Bob" in the conversation that asked, with what was passed under it. */
  function chip(threadId: string, at: Where, to: Person, message: string) {
    store.appendMessage(threadId, {
      role: "bot", kind: "activity", tool: { name: `Told ${to.name}`, ok: true, output: message },
      relay: { kind: "told", email: to.email, name: to.name }, ...(at.group ? { from: from(at.bot) } : {}),
    });
  }

  function replyBack(threadId: string, at: Where, relay: Relay, to: Person, replier: Person, message: string): Passed | null {
    const origin = relay.originThreadId;
    const back = where(at.bot.id, origin);
    if (!back || !deps.sees(to).thread(origin)) return null;
    const posted = store.appendMessage(origin, {
      role: "bot", kind: "text", text: `${replier.name} replied: ${message}`, relay: { kind: "reply", email: replier.email, name: replier.name },
      ...(back.group ? { from: from(at.bot) } : {}),
    });
    markUnread(at.bot.id, origin, back.group);
    tell(to, { where: back, threadId: origin, messageId: posted.id, title: `${replier.name} replied via ${at.bot.name}`, from: replier.name, fromPerson: replier, text: message });
    chip(threadId, at, to, message);
    return { status: 200, text: `Passed back to ${to.name} in the conversation they asked from; they were notified.` };
  }

  function postHere(threadId: string, at: Where, to: Person, asker: Person | undefined, message: string): Passed {
    const posted = store.appendMessage(threadId, { role: "bot", kind: "text", text: `@${to.name} ${message}`, ...(at.group ? { from: from(at.bot) } : {}) });
    markUnread(at.bot.id, threadId, at.group);
    tell(to, { where: at, threadId, messageId: posted.id, title: asker ? `Message from ${asker.name} via ${at.bot.name}` : `${at.bot.name} mentioned you`,
      from: asker?.name ?? at.bot.name, fromPerson: asker, text: message });
    toldThisTurn.set(threadId, (toldThisTurn.get(threadId) ?? new Set<string>()).add(to.key));
    return { status: 200, text: `${to.name} can see this conversation, so your message is posted here tagging them, and they were notified. Don't repeat it.` };
  }

  function deliver(threadId: string, at: Where, to: Person, asker: Person | undefined, message: string): Passed {
    const bot = at.bot;
    const earlier = relays.findLast((relay) => relay.originThreadId === threadId && relay.to === to.key && relay.botId === bot.id);
    const kept = earlier && store.taskByThread(bot.id, earlier.threadId);
    let target = kept && !kept.archivedAt ? kept.threadId : undefined;
    const sender = asker?.name ?? at.group?.name ?? bot.name;
    const title = `From ${sender}`;
    if (!target) {
      const task = store.createTask(bot.id, title, false);
      if (!task) return { status: 500, text: "The conversation couldn't be made. Try again shortly." };
      deps.starters.set(task.threadId, to.key);
      target = task.threadId;
      relays.push({ threadId: target, botId: bot.id, originThreadId: threadId, from: asker?.key ?? null, fromName: sender.slice(0, 200), to: to.key, at: now() });
    }
    const posted = store.appendMessage(target, asker
      ? { role: "bot", kind: "text", text: `${asker.name} asked me to pass this on: ${message}`, relay: { kind: "from", email: asker.email, name: asker.name } }
      : { role: "bot", kind: "text", text: `A message for you from ${sender}: ${message}` });
    store.patchTask(bot.id, target, { unread: true });
    tell(to, { where: { bot }, threadId: target, messageId: posted.id, title: `Message from ${sender} via ${bot.name}`, from: sender, fromPerson: asker, text: message });
    chip(threadId, at, to, message);
    return {
      status: 200,
      text: `Passed on to ${to.name} in a private conversation between them and you ("${kept ? kept.title : title}"); they were notified. Only your message went, nothing else from here.${asker ? ` If ${to.name} answers there, you will pass it back here.` : ""}`,
    };
  }

  /** message_person: one message to one teammate, by the one rule in docs/team-cloud.md "Telling a teammate". */
  function pass(botId: string, threadId: string, rawTo: string, message: string): Passed {
    const at = where(botId, threadId);
    if (!at) return { status: 403, text: "This conversation isn't one you speak in." };
    const found = resolve(rawTo);
    if ("error" in found) return { status: found.status, text: found.error };
    const to = found.person;
    const asker = askerOf(threadId);
    const relay = relays.find((one) => one.threadId === threadId && one.botId === botId);
    const replying = relay !== undefined && relay.from === to.key;
    if (!replying && asker?.key === to.key) return { status: 400, text: `${to.name} is who you are talking with here: tell them in your reply.` };
    if (recent(threadId).length >= MESSAGE_PERSON_HOURLY) {
      return { status: 429, text: `You have passed ${MESSAGE_PERSON_HOURLY} messages from this conversation in the last hour, the most allowed. Don't retry: tell the person it can go later.` };
    }
    const view = deps.sees(to);
    if (!view.bot(botId)) return { status: 403, text: `${to.name} can't use ${at.bot.name}, so this can't reach them from here. Tell the person to reach ${to.name} another way.` };
    const passed = (replying && asker ? replyBack(threadId, at, relay, to, asker, message) : null)
      ?? (view.thread(threadId) ? postHere(threadId, at, to, asker, message) : deliver(threadId, at, to, asker, message));
    if (passed.status === 200) spend(threadId);
    save();
    return passed;
  }

  const handledTurns = new Set<string>();
  const mentionable = () => mentionablePeople(current().map((one) => ({ key: one.key, name: one.name })));
  const botNames = () => store.bots.filter((bot) => !bot.hidden).map((bot) => bot.name);
  /** Who a group chat's or a bot's conversation speaks as in a notification. */
  function owner(threadId: string): Where | null {
    const group = store.groupByThread(threadId);
    if (group) {
      const bot = group.memberIds.map((member) => store.bot(member)).find((member): member is BotRecord => Boolean(member && !member.hidden));
      return bot ? { bot, group } : null;
    }
    const bot = store.botByThread(threadId);
    return bot ? { bot } : null;
  }

  function personWrote(threadId: string, line: Message) {
    const writer = byKey(line.sender?.id);
    if (writer) {
      const before = waiting.length;
      waiting = waiting.filter((item) => !(item.person === writer.key && item.threadId === threadId));
      if (waiting.length !== before) save();
    }
    const at = owner(threadId);
    if (!at || !line.text) return;
    const writerName = writer?.name ?? line.sender?.name ?? "Someone";
    const place = at.group?.name ?? at.bot.name;
    for (const hit of teammateMentions(line.text, mentionable(), botNames())) {
      const to = byKey(hit.key);
      if (!to || to.key === writer?.key || !deps.sees(to).thread(threadId)) continue;
      tell(to, { where: at, threadId, messageId: line.id, title: `${writerName} mentioned you in ${place}`, from: writerName, fromPerson: writer, text: hit.excerpt });
    }
  }

  function turnSettled(threadId: string, line: Message) {
    const key = `${threadId}:${line.turnId}`;
    if (handledTurns.has(key)) return;
    handledTurns.add(key);
    if (handledTurns.size > MAX_HANDLED_TURNS) handledTurns.delete(handledTurns.values().next().value!);
    const told = toldThisTurn.get(threadId) ?? new Set<string>();
    toldThisTurn.delete(threadId);
    if (line.turnSucceeded !== true) return;
    const group = store.groupByThread(threadId);
    const speaker = line.from?.botId ? store.bot(line.from.botId) : store.botByThread(threadId);
    if (!speaker) return;
    const at: Where = group ? { bot: speaker, group } : { bot: speaker };
    const texts = store.activePath(threadId).filter((message) => message.role === "bot" && message.kind === "text" && message.turnId === line.turnId
      && (!group || message.from?.botId === speaker.id));
    for (const text of texts) {
      for (const hit of teammateMentions(text.text ?? "", mentionable(), botNames())) {
        const to = byKey(hit.key);
        if (!to || told.has(to.key) || !deps.sees(to).thread(threadId)) continue;
        told.add(to.key);
        tell(to, { where: at, threadId, messageId: text.id, title: group ? `${speaker.name} mentioned you in ${group.name}` : `${speaker.name} mentioned you`,
          from: speaker.name, text: hit.excerpt });
      }
    }
  }

  const unsubscribe = team ? store.onChange((change: StoreChange) => {
    if (change.type === "message") {
      const line = change.message;
      if (line.role === "user" && line.kind === "text" && !line.peerAsk && line.sender?.id) personWrote(change.threadId, line);
    } else if (change.type === "message.patch") {
      const line = change.message;
      if (line.role === "bot" && line.kind === "text" && line.turnId && line.turnSucceeded !== undefined) turnSettled(change.threadId, line);
    } else if (change.type === "thread.deleted") {
      const before = waiting.length + relays.length;
      waiting = waiting.filter((item) => item.threadId !== change.threadId);
      relays = relays.filter((relay) => relay.threadId !== change.threadId);
      if (waiting.length + relays.length !== before) save();
    }
  }) : () => {};

  const sessionPerson = (auth: RequestAuth) => (auth.kind === "session" && auth.session.email ? byKey(keyOf(auth.session.email)) : undefined);

  return {
    /** The internal call behind message_person, inside index.ts's /api/internal/ block: the bot and the conversation are
     * the capability's, never a body field. */
    async internal(ctx: MessagePersonContext): Promise<typeof PASS | void> {
      if (ctx.path !== MESSAGE_PERSON_PATH) return PASS;
      if (ctx.method !== "POST") return ctx.json(ctx.res, 405, { error: "method not allowed" });
      if (!team || !deps.people) return ctx.json(ctx.res, 404, { error: "Passing a message to a person works only on a team's Cloud." });
      const body = bodySchema.safeParse(await ctx.readBody());
      if (!body.success) return ctx.json(ctx.res, 400, { error: `message_person needs to (a teammate's name or email) and message (up to ${MESSAGE_PERSON_MAX} characters).` });
      const passed = pass(ctx.botId, ctx.threadId, body.data.to, body.data.message);
      return ctx.json(ctx.res, passed.status, passed.status === 200 ? { text: passed.text } : { error: passed.text });
    },
    pass,
    /** What a turn here is told about the team's people and message_person; empty off a team or without the tool. */
    prompt(botId: string, threadId: string, tools: boolean): string {
      if (!team || !tools) return "";
      const own = audienceMember(deps.audienceOf(threadId));
      const others = current().filter((one) => one.key !== own);
      if (!others.length) return "";
      const shown = others.slice(0, PROMPT_PEOPLE).map((one) => `${JSON.stringify(oneLine(one.name, 80))}${one.role === "member" ? "" : ` (${one.role})`}`).join(", ");
      const more = others.length > PROMPT_PEOPLE ? `, and ${others.length - PROMPT_PEOPLE} more` : "";
      const relay = relays.find((one) => one.threadId === threadId && one.botId === botId);
      const asked = relay?.from && byKey(relay.from) ? JSON.stringify(oneLine(relay.fromName, 80)) : null;
      return `\n\nThe people in ${team.name} (the names they chose): ${shown}${more}. To get a message to one of them, call message_person with their name and the message. In a private chat, "tell Bob …", "let Bob know …" or a line that tags @Bob asks you to pass it on: do it, then say so in a few words. Only your message goes, never this conversation, so write it to make sense on its own. In a conversation they can see, a tag like @Bob already reaches them.`
        + (asked ? ` This conversation began when ${asked} asked you to pass a message on (its first line); you cannot see the rest of ${asked}'s chat. When this person answers or asks you to reply, pass the answer back with message_person to ${asked}: it reaches the conversation ${asked} asked from.\n` : "\n");
    },
    /** This person's Needs you lines: tags and passed messages in conversations they can still see, newest first. */
    needsYou(auth: RequestAuth): NeedsYouItem[] {
      const me = sessionPerson(auth);
      if (!team || !me) return [];
      const view = deps.sees(me);
      return waiting.filter((item) => item.person === me.key && now() - item.at < WAITING_MS && view.thread(item.threadId))
        .sort((a, b) => b.at - a.at)
        .map((item) => ({ kind: "message", id: item.id, at: item.at, botId: item.botId, threadId: item.threadId,
          ...(item.messageId ? { messageId: item.messageId } : {}), from: item.from, ...(item.fromEmail ? { fromEmail: item.fromEmail } : {}), text: item.text }));
    },
    /** The person opened this conversation: what waited there for them is done. */
    seen(auth: RequestAuth, threadId: string): void {
      const me = sessionPerson(auth);
      if (!me) return;
      const before = waiting.length;
      waiting = waiting.filter((item) => !(item.person === me.key && item.threadId === threadId));
      if (waiting.length !== before) save();
    },
    stop: unsubscribe,
  };
}

export type TeamMessages = ReturnType<typeof createTeamMessages>;
