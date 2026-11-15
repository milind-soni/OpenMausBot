// Slack for Team Clouds on the Team Cloud (docs/team-slack.md, server/team-slack.ts): a message the Admin hands over
// with the member's own session becomes that member's own line, sent the way their composer sends it, in a conversation
// of the audience the message asks for. A Slack channel thread is a conversation its writer opened and shared with the
// team at once; a Slack direct message is their private chat with the bot. What the run does is read from the
// conversation's own records as they change, and reported to the Admin.
// Security invariants: the session decides who asks, at their level on the bot; the audience named in the request is
// checked against the conversation's own, so a channel's message never lands in a private chat and a direct message
// never in a shared one; a bot the member can't chat with answers as one that doesn't exist; nothing in a report's
// answer stops or starts anything.
import { isPersistentQuestionCard } from "../../shared/ask-question.ts";
import { atLeast } from "../../shared/bot-access.ts";
import { defaultBotPerson } from "../../shared/default-bot.ts";
import type { ResolvedSender } from "../../shared/wire.ts";
import { memberAudience, type Audience } from "../audience.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { CloudHomeConfig } from "../cloud-home.ts";
import type { DirectSendInput, DirectSendReceipt } from "../direct-send.ts";
import { requestNeedsInput } from "../guarded-requests.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { isStopCommand } from "../room-holds.ts";
import { serverLine } from "../server-lines.ts";
import { cancelSteeredMessage, onSteeredQueueChange, queuedSteeredMessage, queuedSteerSender } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import {
  TEAM_SLACK_ANSWER_MAX, TEAM_SLACK_FINAL, TEAM_SLACK_RUNNING_EVERY_MS, createTeamSlackMessages, createTeamSlackReporter, teamSlackKey, teamSlackOver,
  type TeamSlackAccepted, type TeamSlackMessage, type TeamSlackRecord, type TeamSlackReport, type TeamSlackReporter, type TeamSlackState, type TeamSlackWaiting,
} from "../team-slack.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { sharedBeyondOwner } from "./member-bots.ts";
import type { Actor } from "./run-owner.ts";
import { oneLine } from "./text-clip.ts";

/** A run that reads as ended without an answer is failed only once it has read so for this long: a turn's end, a
 * restart on another engine and a queued line's start each leave the conversation idle for a moment. */
export const TEAM_SLACK_SETTLE_MS = 8_000;
const RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000], RETRY_FOR_MS = 6 * 3_600_000;

interface Timer { unref?(): unknown }

export interface TeamSlackHostDeps {
  cloudHome: Pick<CloudHomeConfig, "team" | "machineId" | "adminOrigin" | "publicOrigin" | "bootstrapSecret"> | null;
  dataDir: string;
  store: Pick<Store, "bot" | "bots" | "botByThread" | "taskByThread" | "createTask" | "activePath" | "onChange">;
  visibleFor(auth: RequestAuth): Pick<VisibleSet, "bot" | "level" | "thread">;
  sender(auth: RequestAuth): ResolvedSender | undefined;
  trigger(auth: RequestAuth): UsageTrigger;
  actor(auth: RequestAuth): Actor;
  audienceOf(threadId: string): Audience;
  starters: { set(threadId: string, person: string): void };
  /** Shares a conversation its person just opened with the team, as one from Slack. */
  shareFromSlack(threadId: string, person: string): void;
  /** The app's own deletion of a conversation. */
  discard(botId: string, threadId: string): void;
  /** The composer's own send (index.ts acceptDirectSend). */
  send(input: DirectSendInput): Promise<DirectSendReceipt>;
  busy(botId: string, threadId: string): boolean;
  /** Work this conversation handed to other bots is still moving. */
  handedOn(threadId: string): boolean;
  /** The request this conversation's run answers. */
  request(threadId: string): { messageId?: string } | undefined;
  stopRefusal(threadId: string, by: Actor): string | null;
  removeRefusal(threadId: string, sender: ResolvedSender | undefined, by: Actor): string | null;
  stopThread(botId: string, threadId: string, by?: ResolvedSender): Promise<void>;
  language(person?: string): string | undefined;
  reporter?: TeamSlackReporter;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => Timer;
}

export interface TeamSlackAnswer { status: number; body: Record<string, unknown> }

type Phase = { state: TeamSlackState; waiting?: TeamSlackWaiting; text?: string } | "unsettled";

const refusal = (status: number, code: string, error: string): TeamSlackAnswer => ({ status, body: { error, code } });
const NO_SUCH_BOT = refusal(404, "no_such_bot", "No such bot.");
const NO_SUCH_CONVERSATION = refusal(409, "no_such_conversation", "No such conversation.");

/** Usable where everyone the team shares the bot with reads along: never a member's own MausBot, never a bot only its owner uses. */
export const teamSlackShared = (bot: BotRecord): boolean => !defaultBotPerson(bot) && sharedBeyondOwner(bot);

const openCard = (message: Message): boolean => Boolean(message.card?.requestId && !message.card.answered && !message.card.dismissed && !message.card.expired);
const isRequest = (message: Message): boolean => message.requestPending !== undefined || message.requestCancelled === true;

/** The member's line and the request it runs under: that line, or the one it joined (one person's lines that waited
 * together are answered by one turn, the last of them its request). */
export function teamSlackLines(path: readonly Message[], sendId: string): { at: number; request: number } | null {
  const at = path.findIndex((message) => message.role === "user" && message.sendId === sendId);
  if (at < 0) return null;
  let request = at;
  if (path[at]!.steered) {
    while (request >= 0 && !(path[request]!.role === "user" && isRequest(path[request]!))) request--;
  } else {
    while (!isRequest(path[request]!) && path[request + 1]?.role === "user" && !path[request + 1]!.steered) request++;
  }
  return { at, request: request >= 0 && isRequest(path[request]!) ? request : -1 };
}

/** What the conversation's records say of one Slack message's run. */
export function teamSlackPhase(path: readonly Message[], sendId: string, live: { queued: boolean; busy: boolean; handedOn: boolean }): Phase {
  if (live.queued) return { state: "running" };
  const lines = teamSlackLines(path, sendId);
  if (!lines) return { state: "stopped" };
  if (lines.request < 0) return live.busy ? { state: "running" } : "unsettled";
  const line = path[lines.request]!;
  if (line.requestCancelled) return { state: "stopped" };
  const after = path.slice(lines.request + 1);
  const next = after.findIndex((message) => message.role === "user" && !message.steered);
  const run = next < 0 ? after : after.slice(0, next);
  if (line.requestPending === false) {
    const reply = lines.request === lines.at ? run.findLast((message) => message.role === "bot" && message.kind === "text" && message.turnTerminal) : undefined;
    return { state: "completed", ...(reply?.text ? { text: reply.text } : {}) };
  }
  if (next >= 0) return { state: "failed" };
  // A question outlives the turn that asked it, so it holds this run only while that turn is still blocked on it.
  const card = run.find((message) => requestNeedsInput(message) || (live.busy && openCard(message)));
  if (card) return { state: "waiting", waiting: card.card?.requestId && !isPersistentQuestionCard(card.card) ? "approval" : "question" };
  return live.busy || live.handedOn ? { state: "running" } : "unsettled";
}

export function createTeamSlackHost(deps: TeamSlackHostDeps) {
  const home = deps.cloudHome?.team ? deps.cloudHome : null;
  if (!home) return null;
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const later = (run: () => void, ms: number) => { setTimer(run, ms).unref?.(); };
  const messages = createTeamSlackMessages({ dataDir: deps.dataDir, now });
  const report = deps.reporter ?? createTeamSlackReporter({ machineId: home.machineId, adminOrigin: home.adminOrigin, secret: home.bootstrapSecret, now, log: (line) => console.log(`team slack: ${line}`) });

  const member = (auth: RequestAuth): { person: string } | null =>
    auth.kind === "session" && auth.session.membershipAuthority === "team" && auth.session.email ? { person: personKey(auth.session) } : null;
  const chattable = (auth: RequestAuth) => {
    const visible = deps.visibleFor(auth);
    return (bot: BotRecord) => !bot.hidden && visible.bot(bot.id) && atLeast(visible.level(bot.id), "chat");
  };
  const openUrl = (record: Pick<TeamSlackRecord, "botId" | "threadId">) => `${home.publicOrigin}/?thread=${encodeURIComponent(record.threadId)}&bot=${encodeURIComponent(record.botId)}`;
  const accepted = (record: TeamSlackRecord): TeamSlackAccepted => ({ accepted: true, conversationId: record.threadId, bot: { id: record.botId, name: record.botName }, openUrl: openUrl(record) });

  const sending = new Set<string>(), unsettledSince = new Map<string, number>(), retries = new Map<string, { tries: number; since: number }>();
  /** Each settled run's final reply, in memory until the Admin has it: the conversation may move on before a retry. */
  const replies = new Map<string, string>();
  const open = () => messages.all().filter((record) => !teamSlackOver(record));

  const phaseOf = (record: TeamSlackRecord): Phase => {
    if (!store.taskByThread(record.botId, record.threadId)) return { state: "stopped" };
    return teamSlackPhase(store.activePath(record.threadId), record.id, {
      queued: queuedSteeredMessage(record.botId, record.threadId, record.id) !== null,
      busy: deps.busy(record.botId, record.threadId), handedOn: deps.handedOn(record.threadId),
    });
  };

  async function flush(id: string): Promise<void> {
    if (sending.has(id)) return;
    sending.add(id);
    try {
      for (;;) {
        const record = messages.get(id);
        if (!record || teamSlackOver(record) || record.told === teamSlackKey(record)) return;
        const key = teamSlackKey(record), final = TEAM_SLACK_FINAL.has(record.state);
        const phase = record.state === "completed" && !replies.has(id) ? phaseOf(record) : null;
        const text = replies.get(id) ?? (phase && phase !== "unsettled" ? phase.text : undefined);
        const body: TeamSlackReport = {
          id, status: record.state, conversationId: record.threadId, bot: { id: record.botId, name: record.botName }, openUrl: openUrl(record),
          ...(record.state === "waiting" ? { waiting: record.waiting ?? "question" } : {}),
          ...(record.state === "failed" ? { error: "failed" as const } : {}),
          ...(record.state === "completed" && text ? { text: text.slice(0, TEAM_SLACK_ANSWER_MAX) } : {}),
        };
        const outcome = await report(body);
        const current = messages.get(id);
        if (!current) return;
        if (outcome === "over") { replies.delete(id); messages.patch(id, { closed: true }); return; }
        if (outcome === "told") { retries.delete(id); if (final) replies.delete(id); messages.patch(id, { told: key }); continue; }
        if (teamSlackKey(current) !== key) continue;
        // A report the Admin won't take as it is, or a `running` nobody answered, is not said again; the next state is.
        if (outcome === "refused" || (!final && current.state === "running")) { if (final) { replies.delete(id); messages.patch(id, { closed: true }); } return; }
        const tried = retries.get(id) ?? { tries: 0, since: now() };
        if (now() - tried.since > RETRY_FOR_MS) { retries.delete(id); replies.delete(id); messages.patch(id, { closed: true }); return; }
        retries.set(id, { tries: tried.tries + 1, since: tried.since });
        later(() => void flush(id), RETRY_MS[Math.min(tried.tries, RETRY_MS.length - 1)]!);
        return;
      }
    } finally {
      sending.delete(id);
    }
  }

  function settle(id: string): void {
    const record = messages.get(id);
    if (!record || teamSlackOver(record) || TEAM_SLACK_FINAL.has(record.state)) return;
    let phase = phaseOf(record);
    if (phase === "unsettled") {
      const since = unsettledSince.get(id) ?? now();
      unsettledSince.set(id, since);
      if (now() - since < TEAM_SLACK_SETTLE_MS) { later(() => settle(id), TEAM_SLACK_SETTLE_MS - (now() - since) + 50); return; }
      phase = { state: "failed" };
    }
    unsettledSince.delete(id);
    if (phase.state === record.state && phase.waiting === record.waiting) return;
    if (phase.state === "completed" && phase.text) replies.set(id, phase.text);
    messages.patch(id, { state: phase.state, waiting: phase.waiting });
    void flush(id);
  }

  /** After the change's own fold has finished: a turn's end frees the conversation before it settles the request. */
  const pending = new Set<string>();
  const soon = (records: readonly TeamSlackRecord[]) => {
    for (const record of records) {
      if (pending.has(record.id)) continue;
      pending.add(record.id);
      setImmediate(() => { pending.delete(record.id); settle(record.id); });
    }
  };
  store.onChange((change) => {
    if (change.type === "message" || change.type === "message.patch" || change.type === "thread" || change.type === "thread.deleted") soon(open().filter((record) => record.threadId === change.threadId));
    else if (change.type === "bot" || change.type === "bot.deleted") soon(open().filter((record) => record.botId === change.botId));
  });
  onSteeredQueueChange(() => soon(open()));
  const beat = () => {
    for (const record of open()) {
      if (record.state === "running" && record.told === "running") messages.patch(record.id, { told: undefined });
      void flush(record.id);
    }
    later(beat, TEAM_SLACK_RUNNING_EVERY_MS);
  };
  later(beat, TEAM_SLACK_RUNNING_EVERY_MS);
  // What was open when this server last stopped: its run ended with the process, and what the Admin wasn't told is said now.
  later(() => { for (const record of open()) { settle(record.id); void flush(record.id); } }, 1_000);

  function title(input: TeamSlackMessage, person: string): string {
    const text = oneLine(input.text, 40);
    if (input.audience === "member") return serverLine(deps.language(person), "server.teamSlack.direct", { text });
    const channel = input.slack?.channelName?.replace(/^#/, "");
    return channel ? serverLine(deps.language(), "server.teamSlack.channel", { channel, text }) : serverLine(deps.language(), "server.teamSlack.channelUnnamed", { text });
  }

  /** What the app's own send refused, as the Admin reads it: it tries again on 409, 423, 429 and 5xx, and tells the sender on anything else. */
  function sendRefused(error: unknown): TeamSlackAnswer {
    const thrown = error as { status?: unknown; code?: unknown; body?: { error?: unknown; code?: unknown }; message?: unknown } | null;
    const status = typeof thrown?.status === "number" ? thrown.status : 500;
    const code = typeof thrown?.body?.code === "string" ? thrown.body.code : typeof thrown?.code === "string" ? thrown.code : "refused";
    const words = typeof thrown?.body?.error === "string" ? thrown.body.error : typeof thrown?.message === "string" ? thrown.message : "The message could not be sent.";
    return refusal(status === 409 || status === 423 || status === 429 || status >= 500 ? status : 422, code, words);
  }

  async function take(auth: RequestAuth, person: string, input: TeamSlackMessage): Promise<TeamSlackAnswer> {
    const canChat = chattable(auth), visible = deps.visibleFor(auth);
    const wanted: Audience = input.audience === "team" ? "team" : memberAudience(person);
    let bot: BotRecord | null | undefined, threadId = input.conversationId ?? undefined;
    if (threadId) {
      bot = store.botByThread(threadId);
      if (!bot || !store.taskByThread(bot.id, threadId) || !visible.thread(threadId) || !canChat(bot) || deps.audienceOf(threadId) !== wanted) return NO_SUCH_CONVERSATION;
    } else if ("id" in input.bot) {
      bot = store.bot(input.bot.id);
    } else if ("name" in input.bot) {
      const name = input.bot.name.toLowerCase();
      bot = store.bots.find((one) => canChat(one) && one.name.trim().toLowerCase() === name);
    } else {
      const mine = store.bots.filter(canChat);
      bot = mine.find((one) => defaultBotPerson(one) !== "") ?? mine[0];
    }
    if (!bot || !canChat(bot)) return NO_SUCH_BOT;
    if (input.audience === "team" && !teamSlackShared(bot)) return refusal(403, "bot_private", "That bot is private to its owner.");

    const created = threadId === undefined;
    if (threadId === undefined) {
      const task = store.createTask(bot.id, title(input, person), false, undefined, undefined, undefined, undefined, undefined, (made) => {
        deps.starters.set(made.threadId, person);
        if (input.audience === "team") deps.shareFromSlack(made.threadId, person);
      });
      if (!task) return refusal(503, "unavailable", "The conversation could not be opened.");
      threadId = task.threadId;
      if (deps.audienceOf(threadId) !== wanted) {
        deps.discard(bot.id, threadId);
        return refusal(503, "unavailable", "The conversation could not be opened.");
      }
    }
    let receipt: DirectSendReceipt;
    try {
      receipt = await deps.send({ botId: bot.id, threadId, text: input.text, sendId: input.id, sender: deps.sender(auth), trigger: deps.trigger(auth), personPresent: true, admin: deps.actor(auth).admin, followUp: "queue" });
    } catch (error) {
      if (created) deps.discard(bot.id, threadId);
      return sendRefused(error);
    }
    // A line made of stop words ended the run instead of starting one, as it does in the app.
    const stopWords = !("queued" in receipt) && !receipt.steered && isStopCommand(input.text, bot.name) && deps.request(threadId)?.messageId !== receipt.message.id;
    const record: TeamSlackRecord = { id: input.id, person, botId: bot.id, botName: bot.name, threadId, audience: input.audience, at: now(), state: stopWords ? "stopped" : "running" };
    messages.put(record);
    void flush(record.id);
    soon([record]);
    return { status: 202, body: { ...accepted(record) } };
  }

  const taking = new Map<string, { person: string; answer: Promise<TeamSlackAnswer> }>();

  return {
    /** The bots this member can chat with. */
    bots(auth: RequestAuth): TeamSlackAnswer {
      if (!member(auth)) return refusal(404, "not_a_member", "Not found.");
      return { status: 200, body: { bots: store.bots.filter(chattable(auth)).map((bot) => ({ id: bot.id, name: bot.name, shared: teamSlackShared(bot) })) } };
    },
    /** Starts or continues a conversation with one Slack message, once per id. */
    message(auth: RequestAuth, input: TeamSlackMessage): Promise<TeamSlackAnswer> {
      const who = member(auth);
      if (!who) return Promise.resolve(refusal(404, "not_a_member", "Not found."));
      const notYours = refusal(403, "not_yours", "That message is someone else's.");
      const known = messages.get(input.id);
      if (known) return Promise.resolve(known.person === who.person ? { status: 202, body: { ...accepted(known) } } : notYours);
      const running = taking.get(input.id);
      if (running) return running.person === who.person ? running.answer : Promise.resolve(notYours);
      const answer = take(auth, who.person, input).finally(() => taking.delete(input.id));
      taking.set(input.id, { person: who.person, answer });
      return answer;
    },
    /** Stop, pressed in Slack by this member: theirs to stop by the app's own rule, or refused. */
    async stop(auth: RequestAuth, id: string): Promise<TeamSlackAnswer> {
      const who = member(auth);
      if (!who) return refusal(404, "not_a_member", "Not found.");
      const record = messages.get(id);
      if (!record) return refusal(404, "no_such_message", "No such message.");
      if (TEAM_SLACK_FINAL.has(record.state)) return { status: 200, body: { stopped: true } };
      const by = deps.actor(auth), visible = deps.visibleFor(auth);
      const notTheirs = refusal(403, "stop_not_yours", "Only the person who asked can stop this.");
      if (!visible.thread(record.threadId) || !atLeast(visible.level(record.botId), "chat")) return notTheirs;
      const waiting = queuedSteeredMessage(record.botId, record.threadId, id);
      if (waiting) {
        if (deps.removeRefusal(record.threadId, queuedSteerSender(record.botId, record.threadId, waiting.id)?.sender, by)) return notTheirs;
        cancelSteeredMessage(record.botId, waiting.id, record.threadId);
        settle(id);
        return { status: 200, body: { stopped: true } };
      }
      const path = store.activePath(record.threadId), lines = teamSlackLines(path, id), phase = phaseOf(record);
      if (phase !== "unsettled" && TEAM_SLACK_FINAL.has(phase.state)) { settle(id); return { status: 200, body: { stopped: true } }; }
      // Another request runs in this conversation now: this one is not what Stop would end.
      if (!lines || lines.request < 0 || deps.request(record.threadId)?.messageId !== path[lines.request]!.id) return { status: 200, body: { stopped: false } };
      const refused = deps.stopRefusal(record.threadId, by);
      if (refused) return refusal(403, "stop_not_yours", refused);
      await deps.stopThread(record.botId, record.threadId, deps.sender(auth));
      settle(id);
      return { status: 200, body: { stopped: messages.get(id)?.state === "stopped" } };
    },
    /** A member left the team: what this kept of their Slack messages goes; their direct-message conversations go with their private chats. */
    memberLeft(person: string): void {
      for (const id of messages.forgetPerson(person)) { unsettledSince.delete(id); retries.delete(id); replies.delete(id); }
    },
  };
}

export type TeamSlackHost = NonNullable<ReturnType<typeof createTeamSlackHost>>;
