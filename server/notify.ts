import type { Notification, NotifyKind } from "../shared/notification.ts";
import { personMentionExcerpt } from "../shared/person-mention.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "./server-lines.ts";

export type { Notification, NotifyKind } from "../shared/notification.ts";

/** A model's markdown as the plain text a notification banner can show:
 * no fences, headings, emphasis markers, link syntax, bullets, quotes or
 * table pipes. Issue numbers and snake_case words stay as they are. */
export function plainNotificationText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^[ \t]*\|/gm, "")
    .replace(/\|[ \t]*$/gm, "")
    .replace(/^[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*$/gm, "")
    .replace(/[ \t]*\|[ \t]*/g, " · ")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "");
}

/** One line, short enough for a lock screen, with the newlines and the
 * markdown of a model's answer flattened out of it. */
export function summarize(text: string, max = 140): string {
  const line = plainNotificationText(text).replace(/\s+/g, " ").replace(/^[\s·]+|[\s·]+$/g, "").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export interface NotifyBot {
  id: string;
  name: string;
  threadId: string;
  notifications?: boolean;
}

export function buildSpendNotification(
  bot: Pick<NotifyBot, "id" | "name">,
  threadId: string,
  text: { title: string; body: string },
): Notification {
  return { kind: "spend", botId: bot.id, botName: bot.name, threadId, title: text.title, body: summarize(text.body, 200) };
}

/** Something OpenMausBot did on its own about `bot` that the person hears once, in one plain line. */
export function buildNoticeNotification(bot: Pick<NotifyBot, "id" | "name">, threadId: string, text: string): Notification {
  return { kind: "notice", botId: bot.id, botName: bot.name, threadId, title: bot.name, body: summarize(text, 240) };
}


const TITLE: Partial<Record<NotifyKind, ServerLineKey>> = {
  approval: "server.notify.approval",
  question: "server.notify.question",
  "routine-failed": "server.notify.routineFailed",
  "routine-deferred": "server.notify.routineDeferred",
  "turn-failed": "server.notify.turnFailed",
  incident: "server.notify.incident",
  "delegation-settled": "server.notify.delegationSettled",
  mention: "server.notify.mention",
  wait: "server.notify.wait",
};

export function buildNotification(
  kind: NotifyKind,
  bot: Omit<NotifyBot, "threadId"> & { threadId?: string },
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string; group?: { id: string; name: string }; site?: string },
): Notification | null {
  if (bot.notifications === false) return null;

  const body = summarize(detail);
  const language = conversationLanguage(threadId);
  const who = extra?.group ? serverLine(language, "server.notify.inRoom", { bot: bot.name, room: extra.group.name }) : bot.name;
  const title = kind === "sign-in"
    ? extra?.site ? serverLine(language, "server.notify.signIn", { who, site: extra.site }) : serverLine(language, "server.notify.signInWebsite", { who })
    : serverLine(language, TITLE[kind] ?? "server.notify.done", { who });

  if ((kind === "done" || kind === "mention") && !body) return null;

  const notification: Notification = { kind, botId: bot.id, botName: bot.name, threadId, title, body };
  if (extra?.avatarUrl) notification.avatarUrl = extra.avatarUrl;
  if (extra?.group) notification.groupId = extra.group.id;
  return notification;
}

type MentionSource = {
  activePath(threadId: string): readonly { role: string; kind: string; text?: string; turnId?: string; from?: { botId: string } }[];
  bot(id: string): { name: string; hidden?: boolean } | null | undefined;
};

export function buildMentionNotification(
  source: MentionSource,
  bot: Omit<NotifyBot, "threadId"> & { avatarUrl?: string },
  room: { id: string; name: string; dm?: boolean; memberIds: readonly string[] },
  turn: { threadId: string; turnId?: string; reply: string; profileName?: string },
): Notification | null {
  if (room.dm) return null;
  const texts = turn.turnId
    ? source.activePath(turn.threadId).filter((m) => m.role === "bot" && m.kind === "text" && m.turnId === turn.turnId && m.from?.botId === bot.id).map((m) => m.text ?? "")
    : [turn.reply];
  const botNames = room.memberIds.flatMap((id) => {
    const member = source.bot(id);
    return member && !member.hidden ? [member.name] : [];
  });
  for (const text of texts) {
    const excerpt = personMentionExcerpt(text, { profileName: turn.profileName, botNames });
    if (excerpt) return buildNotification("mention", { ...bot, threadId: turn.threadId }, turn.threadId, excerpt, { avatarUrl: bot.avatarUrl, group: room });
  }
  return null;
}
