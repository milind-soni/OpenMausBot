// The inbox of a place that is no team's: this computer, or a Cloud of one person. There is one person here, so nothing is
// copied and nothing routed. An ask is the open card itself, read where it was asked, so one tap answers the one card
// however many surfaces show it, and whatever was waiting before this inbox existed is listed. What a bot sent the person
// is a line of its conversation, and a reply there is an ordinary line of theirs.
// Security: a guest's conversation stays out of the owner's lines, and the owner's stays out of a guest's. An ask is listed
// only for someone who may answer it, so a guest's questions reach the owner labelled with who asked, never as their own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { InboxItem, InboxRow, InboxView } from "../../shared/inbox.ts";
import type { Notification } from "../../shared/notification.ts";
import { personWait, type PersonWait } from "../../shared/person-wait.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { ASK_NOTIFICATIONS } from "../ask-routing.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { RequestAuth } from "../request-auth.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { Message, Store, StoreChange } from "../store.ts";
import { clip, oneLine } from "./text-clip.ts";

export const PLACE_INBOX_FILE = "place-inbox.json";
const MAX_LINES = 2_000;
const MAX_SEEN_ASKS = 2_000;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const VIEW_ROWS = 200;
const ROW_TEXT_MAX = 4_000;
const NOTICE_TEXT_MAX = 2_000;
const HOUR_MS = 60 * 60_000;
/** Messages from one conversation in an hour: enough for real news, too few for a loop to bury the person. */
export const PLACE_MESSAGES_HOURLY = 10;

const id = z.string().min(1).max(512);
const lineSchema = z.object({
  id, botId: id, threadId: id, groupId: id.optional(), kind: z.enum(["message", "result", "notice"]),
  from: z.string().max(200), workingFor: z.object({ botId: id, name: z.string().max(200) }).optional(),
  /** The guest whose conversation this is: it is theirs, not the owner's. */
  guest: id.optional(),
  text: z.string().max(NOTICE_TEXT_MAX), at: z.number(), seen: z.boolean().optional(), done: z.boolean().optional(),
  /** The conversation this result is news for: its next unread result replaces this line, so one job keeps one row. */
  job: id.optional(),
  /** A message posted in a room: only a reply to it (or Done) answers it, not the person's other talk there. */
  untilReply: z.boolean().optional(),
});
const fileSchema = z.object({ version: z.literal(1), lines: z.array(lineSchema).max(MAX_LINES), seenAsks: z.array(id).max(MAX_SEEN_ASKS) });
type Line = z.infer<typeof lineSchema>;

/** An open card as the messages table holds it. */
export interface OpenCardRow { threadId: string; id: string; at: number; card: string | null; fromBotId: string | null }

/** Who is asking for the inbox: its owner (on a server with members, a member), a guest on someone's Cloud, or nobody it
 * belongs to (a bot's shell on a Cloud, a local service). */
export type InboxViewer = { kind: "owner" } | { kind: "guest"; key: string } | { kind: "nobody" };

/** Who is asking on this server. Security: on someone's Cloud loopback is a bot's shell, never its owner, and a session that
 * isn't the owner's is a guest; a local service is nobody's either. */
export function placeInboxViewer(auth: RequestAuth, cloud: { personal: boolean; owner(auth: RequestAuth): boolean; personOf(session: Extract<RequestAuth, { kind: "session" }>["session"]): string }): InboxViewer {
  if (cloud.personal && !cloud.owner(auth)) return auth.kind === "session" ? { kind: "guest", key: cloud.personOf(auth.session) } : { kind: "nobody" };
  return auth.kind === "loopback" && auth.trust === "service" ? { kind: "nobody" } : { kind: "owner" };
}

export interface PlaceInboxDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "botByThread" | "taskByThread" | "groupByThread" | "appendMessage" | "patchTask" | "patchGroup" | "messagesFor" | "onChange">;
  openCards(): OpenCardRow[];
  viewer(auth: RequestAuth): InboxViewer;
  sees(auth: RequestAuth, threadId: string): boolean;
  /** Whose answer counts on this card; decided where cards are answered, so a row never offers what the answer would refuse. */
  mayAnswer(auth: RequestAuth, threadId: string, requestId: string): boolean;
  /** The guest this conversation is for; null for the owner's own, and for work no guest asked for. */
  guestOf(threadId: string): string | null;
  /** The name the guest wrote under in this conversation. */
  guestName(threadId: string): string | undefined;
  /** The bot that handed this conversation's work on. */
  handedBy(threadId: string): string | null;
  /** Bot-to-bot hand-off results kept out of the Inbox: the person asked not to be told what one bot did for another. */
  delegatedLineHidden?(): boolean;
  /** Sends a notification as it is. */
  send(notification: Notification): void;
  /** Conversations resting on the person for a card a running turn does not hold open: a password, a sign-in, an app to
   * connect, or an ask left open after its turn ended. */
  waiting?(): Array<PersonWait & { threadId: string }>;
  now?: () => number;
}


export function createPlaceInbox(deps: PlaceInboxDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, PLACE_INBOX_FILE);
  let lines: Line[] = [];
  let seenAsks = new Set<string>();
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) { lines = parsed.data.lines; seenAsks = new Set(parsed.data.seenAsks); }
    else console.warn(`place inbox: ${file} is not an inbox file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`place inbox: ${file} is unreadable; starting fresh`);
  }
  const save = () => {
    lines = lines.filter((line) => now() - line.at < KEEP_MS).slice(-MAX_LINES);
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, lines, seenAsks: [...seenAsks].slice(-MAX_SEEN_ASKS) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`place inbox: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workingFor = (threadId: string): { botId: string; name: string } | undefined => {
    const botId = deps.handedBy(threadId);
    const bot = botId ? store.bot(botId) : undefined;
    return bot ? { botId: bot.id, name: bot.name } : undefined;
  };

  /** News about work another bot handed on: with the switch on it is filed nowhere but the conversation it happened in. */
  const handOffHidden = (threadId: string): boolean => deps.delegatedLineHidden?.() === true && deps.handedBy(threadId) !== null;

  const titleOf = (botId: string, threadId: string): string => store.groupByThread(threadId)?.name ?? store.taskByThread(botId, threadId)?.title ?? store.bot(botId)?.name ?? "";

  /** The person wrote in the conversation after a bot's message reached them: that is their answer. In a room they keep
   * talking to the others, so there only a reply to that very line answers it (or Done in the Inbox). */
  function answeredThere(line: Line): boolean {
    if (line.kind !== "message") return false;
    const said = store.messagesFor(line.threadId);
    for (let index = said.length - 1; index >= 0 && said[index]!.at >= line.at; index--) {
      const one = said[index]!;
      if (one.role === "user" && !one.peerAsk && !one.relayed && one.via !== "api" && (!line.untilReply || one.replyToId === line.id)) return true;
    }
    return false;
  }

  const lineTab = (line: Line): InboxRow["tab"] => (line.done || answeredThere(line) ? "done" : "info");
  const lineFor = (auth: RequestAuth, line: Line): boolean => {
    const viewer = deps.viewer(auth);
    if (viewer.kind === "nobody" || !deps.sees(auth, line.threadId)) return false;
    return viewer.kind === "guest" ? line.guest === viewer.key : line.guest === undefined;
  };

  function askRows(auth: RequestAuth): InboxRow[] {
    if (deps.viewer(auth).kind === "nobody") return [];
    const rows = new Map<string, InboxRow>();
    for (const row of deps.openCards()) {
      let card: OptionCardData | null = null;
      try { card = row.card ? JSON.parse(row.card) as OptionCardData : null; } catch { continue; }
      if (!card || !personWait({ id: row.id, at: row.at, kind: "options", card }) || !deps.sees(auth, row.threadId) || !deps.mayAnswer(auth, row.threadId, card.requestId!)) continue;
      const bot = (row.fromBotId ? store.bot(row.fromBotId) : undefined) ?? store.botByThread(row.threadId);
      if (!bot) continue;
      const group = store.groupByThread(row.threadId);
      const guest = deps.guestOf(row.threadId);
      const handed = workingFor(row.threadId);
      rows.set(`${row.threadId}\u0000${card.requestId}`, {
        id: row.id, kind: "ask", tab: "needs-you", from: { name: bot.name, botId: bot.id },
        ...(handed ? { workingFor: handed } : {}), ...(guest ? { askedBy: { name: deps.guestName(row.threadId) ?? "" } } : {}),
        origin: { botId: bot.id, threadId: row.threadId, title: titleOf(bot.id, row.threadId), ...(group ? { groupId: group.id } : {}), messageId: row.id },
        text: clip(card.subtitle || card.title || "", ROW_TEXT_MAX), at: row.at, unread: !seenAsks.has(row.id), card,
      });
    }
    const listed = new Set([...rows.values()].map((row) => row.id));
    const viewer = deps.viewer(auth);
    for (const wait of deps.waiting?.() ?? []) {
      if (listed.has(wait.messageId) || !deps.sees(auth, wait.threadId)) continue;
      const guest = deps.guestOf(wait.threadId);
      if (viewer.kind === "guest" ? guest !== viewer.key : guest !== null) continue;
      const said = store.messagesFor(wait.threadId).find((one) => one.id === wait.messageId);
      const bot = (wait.botId ? store.bot(wait.botId) : undefined) ?? store.botByThread(wait.threadId);
      if (!said || !bot) continue;
      const card = said.kind === "options" ? said.card : undefined;
      if (card && !(card.requestId && deps.mayAnswer(auth, wait.threadId, card.requestId))) continue;
      const group = store.groupByThread(wait.threadId);
      const handed = workingFor(wait.threadId);
      rows.set(wait.messageId, {
        id: wait.messageId, kind: "ask", tab: "needs-you", from: { name: bot.name, botId: bot.id }, ...(handed ? { workingFor: handed } : {}),
        origin: { botId: bot.id, threadId: wait.threadId, title: titleOf(bot.id, wait.threadId), ...(group ? { groupId: group.id } : {}), messageId: wait.messageId },
        text: clip(wait.label, ROW_TEXT_MAX), at: wait.at, unread: !seenAsks.has(wait.messageId),
        ...(card ? { card } : {}), ...(said.secret ? { secret: said.secret } : {}), ...(said.signIn ? { signIn: said.signIn } : {}), ...(said.connector ? { connector: said.connector } : {}),
      });
    }
    return [...rows.values()];
  }

  const lineRow = (line: Line): InboxRow => ({
    id: line.id, kind: line.kind, tab: lineTab(line), from: { name: line.from, botId: line.botId }, ...(line.workingFor ? { workingFor: line.workingFor } : {}),
    origin: { botId: line.botId, threadId: line.threadId, title: titleOf(line.botId, line.threadId), ...(line.groupId ? { groupId: line.groupId } : {}), messageId: line.id },
    text: clip(line.text, ROW_TEXT_MAX), at: line.at, unread: !line.seen, ...(line.kind === "message" ? { replies: true as const } : {}),
  });

  function view(auth: RequestAuth): InboxView {
    // The switch also drops the hand-off lines filed before it was turned on, so the list says what the person asked for.
    // A bot's own message to the person is not a hand-off report, so it always stays.
    const hidden = deps.delegatedLineHidden?.() === true;
    const rows = [...askRows(auth), ...lines.filter((line) => lineFor(auth, line) && !(hidden && line.workingFor && line.kind !== "message")).map(lineRow)].sort((a, b) => b.at - a.at).slice(0, VIEW_ROWS);
    return { botId: null, threadId: null, rows, anchor: null };
  }

  function addLine(line: Line): Line {
    if (line.job) lines = lines.filter((one) => one.job !== line.job || one.seen || one.done);
    lines.push(line);
    save();
    return line;
  }

  const sent = new Map<string, number[]>();
  const recent = (threadId: string) => (sent.get(threadId) ?? []).filter((at) => now() - at < HOUR_MS);

  /** message_person with no team: one line in the conversation that sent it, one row, and one notification. */
  function message(botId: string, threadId: string, text: string): { status: number; text: string } {
    const bot = store.bot(botId);
    if (!bot) return { status: 403, text: "This conversation isn't one you speak in." };
    const group = store.groupByThread(threadId);
    if (bot.threadId !== threadId && !store.taskByThread(botId, threadId) && !group?.memberIds.includes(botId)) return { status: 403, text: "This conversation isn't one you speak in." };
    if (recent(threadId).length >= PLACE_MESSAGES_HOURLY) return { status: 429, text: `You have sent ${PLACE_MESSAGES_HOURLY} messages from this conversation in the last hour, the most allowed. Don't retry: put it in your reply.` };
    sent.set(threadId, [...recent(threadId), now()]);
    const handed = workingFor(threadId);
    const guest = deps.guestOf(threadId);
    const wire: InboxItem = { kind: "message", from: { name: bot.name, botId: bot.id }, replies: true };
    const posted = store.appendMessage(threadId, { role: "bot", kind: "text", text, inbox: wire, ...(group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}) });
    addLine({ id: posted.id, botId: bot.id, threadId, ...(group ? { groupId: group.id } : {}), kind: "message", from: bot.name.slice(0, 200), ...(handed ? { workingFor: handed } : {}),
      ...(guest ? { guest } : {}), ...(group ? { untilReply: true } : {}), text: clip(text, NOTICE_TEXT_MAX), at: now() });
    if (group) store.patchGroup(group.id, { unread: true });
    else store.patchTask(bot.id, threadId, { unread: true });
    if (!guest && bot.notifications !== false) {
      deps.send({ kind: "mention", botId: bot.id, botName: bot.name, threadId, title: handed ? serverLine(conversationLanguage(threadId), "server.notify.workingFor", { who: bot.name, other: handed.name }) : serverLine(conversationLanguage(threadId), "server.notify.message", { who: bot.name }), body: oneLine(text, 200),
        ...(group ? { groupId: group.id } : {}), ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) });
    }
    return { status: 200, text: group
      ? "It is posted in this room and in their Inbox, and they were notified; it stays open there until they reply to it or mark it done. Their answer comes back here, and you carry on from it."
      : "It is in their Inbox and they were notified. Their answer comes back here, and you carry on from it." };
  }

  /** A routine's report, the answer that sums up work handed out, or a failure of work nobody is watching gets a line; the
   * notification about it goes out as it is. */
  function route(notification: Notification, how: { routine?: boolean; summary?: boolean } = {}): Notification {
    const { kind, botId, threadId } = notification;
    const result = (kind === "done" && (how.routine === true || how.summary === true)) || (kind === "delegation-settled" && how.summary === true);
    const notice = ASK_NOTIFICATIONS.has(kind) && kind !== "approval" && kind !== "question" && (how.routine === true || deps.handedBy(threadId) !== null);
    const bot = (result || notice) && !handOffHidden(threadId) ? store.bot(botId) : undefined;
    if (bot) {
      const handed = workingFor(threadId);
      const guest = deps.guestOf(threadId);
      addLine({ id: crypto.randomUUID(), botId: bot.id, threadId, ...(notification.groupId ? { groupId: notification.groupId } : {}), kind: result ? "result" : "notice", from: bot.name.slice(0, 200),
        ...(handed ? { workingFor: handed } : {}), ...(guest ? { guest } : {}), text: clip(notification.body || notification.title, NOTICE_TEXT_MAX), at: now(), ...(how.summary ? { job: threadId } : {}) });
    }
    return notification;
  }

  /** Work handed on finished: one line, so the result is here even if the conversation that asked never reports back. It
   * sends nothing, and that conversation's next result or its summary replaces it. */
  function handedResult(work: { botId: string; threadId: string; groupId?: string; text: string }, requester: { botId: string; threadId: string }): void {
    // This path only ever carries work one bot handed to another, so the switch alone decides.
    if (deps.delegatedLineHidden?.() === true) return;
    const bot = store.bot(work.botId);
    const text = work.text.trim();
    if (!bot || bot.notifications === false || !text) return;
    const asked = store.bot(requester.botId);
    const guest = deps.guestOf(requester.threadId);
    addLine({ id: crypto.randomUUID(), botId: bot.id, threadId: work.threadId, ...(work.groupId ? { groupId: work.groupId } : {}), kind: "result", from: bot.name.slice(0, 200),
      ...(asked ? { workingFor: { botId: asked.id, name: asked.name } } : {}), ...(guest ? { guest } : {}), text: clip(text, NOTICE_TEXT_MAX), at: now(), job: requester.threadId });
  }

  const unsubscribe = store.onChange((change: StoreChange) => {
    if (change.type !== "thread.deleted") return;
    const before = lines.length;
    lines = lines.filter((line) => line.threadId !== change.threadId);
    if (lines.length !== before) save();
  });

  return {
    view,
    message,
    route,
    handedResult,
    /** What waits on this viewer: every open ask, and news they have not read. */
    count(auth: RequestAuth): number {
      return view(auth).rows.filter((row) => row.tab === "needs-you" || (row.tab === "info" && row.unread)).length;
    },
    markRead(auth: RequestAuth, lineId: string): boolean {
      const line = lines.find((one) => one.id === lineId && lineFor(auth, one));
      if (line) {
        if (!line.seen) { line.seen = true; save(); }
        return true;
      }
      if (!askRows(auth).some((row) => row.id === lineId)) return false;
      if (!seenAsks.has(lineId)) { seenAsks.add(lineId); save(); }
      return true;
    },
    /** Every line and open ask this viewer lists is read; an ask is only marked read, never answered. */
    markAllRead(auth: RequestAuth): number {
      let changed = 0;
      for (const line of lines) if (!line.seen && lineFor(auth, line)) { line.seen = true; changed++; }
      for (const row of askRows(auth)) if (!seenAsks.has(row.id)) { seenAsks.add(row.id); changed++; }
      if (changed) save();
      return changed;
    },
    markDone(auth: RequestAuth, lineId: string): "done" | "unknown" | "an ask" {
      const line = lines.find((one) => one.id === lineId && lineFor(auth, one));
      if (line) {
        if (!line.done) { line.done = true; line.seen = true; save(); }
        return "done";
      }
      return askRows(auth).some((row) => row.id === lineId) ? "an ask" : "unknown";
    },
    /** The person opened this conversation: what waited there for them is read. */
    seen(auth: RequestAuth, threadId: string): void {
      let changed = false;
      for (const line of lines) if (line.threadId === threadId && !line.seen && lineFor(auth, line)) { line.seen = true; changed = true; }
      if (changed) save();
    },
    stop: unsubscribe,
  };
}

export type PlaceInbox = ReturnType<typeof createPlaceInbox>;

/** The name a guest wrote under last in a conversation. */
export const guestNameIn = (lines: readonly Pick<Message, "role" | "peerAsk" | "sender">[]): string | undefined =>
  lines.findLast((line) => line.role === "user" && !line.peerAsk && line.sender?.name)?.sender?.name;
