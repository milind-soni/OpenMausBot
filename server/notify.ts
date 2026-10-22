import { NOTIFY_IN_ROOM_KEY, NOTIFY_TITLE_KEY, type Notification, type NotifyKind } from "../shared/notification.ts";
import { personMentionExcerpt } from "../shared/person-mention.ts";
import { formatServerText } from "../shared/server-text.ts";

export type { Notification, NotifyKind } from "../shared/notification.ts";

export function summarize(text: string, max = 140): string {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
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

/** The client words each title by key and falls back to this English, which the server keeps sending for older clients. */
export const NOTIFICATION_TITLE = {
  "notifications.banner.approval": "{who} needs approval",
  "notifications.banner.question": "{who} has a question",
  "notifications.banner.done": "{who} finished",
  "notifications.banner.mention": "{who} mentioned you",
  "notifications.banner.turnFailed": "{who} couldn't start",
  "notifications.banner.routineFailed": "{who}'s routine failed",
  "notifications.banner.routineDeferred": "{who}'s routine is waiting",
  "notifications.banner.incident": "{who} hit a problem",
  "notifications.banner.delegationSettled": "{who} resumed with results",
  "notifications.banner.inRoom": "{name} in {room}",
} as const;

export function buildNotification(
  kind: NotifyKind,
  bot: NotifyBot,
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string; group?: { id: string; name: string }; site?: string },
): Notification | null {
  if (bot.notifications === false) return null;

  const body = summarize(detail);
  const who = extra?.group
    ? formatServerText(NOTIFICATION_TITLE[NOTIFY_IN_ROOM_KEY], { name: bot.name, room: extra.group.name })
    : bot.name;
  const title = kind === "sign-in"
    ? `${who} needs you to sign in to ${extra?.site ?? "a website"}`
    : formatServerText(NOTIFICATION_TITLE[kind === "spend" || kind === "brief" ? NOTIFY_TITLE_KEY.done : NOTIFY_TITLE_KEY[kind]], { who });

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
