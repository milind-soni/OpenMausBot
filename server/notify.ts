// Notifications — what is worth interrupting someone for.
//
// `BotRecord.notifications` has been a switch in the settings panel that
// nothing read. This is the thing that reads it. The rule it encodes is
// small and deliberate: a bot that is *blocked on you* is worth a buzz, and
// a bot that *finished* is worth one if you asked for it; everything else a
// bot does while it works is not.
//
// Delivery is a separate concern. The harness emits a frame; whoever is
// listening decides what to do with it — desktop and paired-phone local
// notifications today, and closed-app APNs delivery once a relay exists.

export type NotifyKind = "approval" | "question" | "done" | "routine-failed" | "takeover";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  /** The bot's stored profile image, when it has one; clients show it as
   * the OS notification's icon so every banner carries its bot's face. */
  avatarUrl?: string;
}

/** One line, short enough for a lock screen, with the newlines and code
 * fences of a model's answer flattened out of it. */
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

/** Build the frame for one event, or null when it should stay quiet.
 *
 * Kept pure and separate from the event fold so the policy — which is the
 * part people will argue about — can be read and tested on its own. */
export function buildNotification(
  kind: NotifyKind,
  bot: NotifyBot,
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string },
): Notification | null {
  // The toggle means what it says: off is off, including for approvals.
  // A bot whose notifications you turned off can still block waiting for
  // you — that is the choice you made, and the chat still shows the card.
  if (bot.notifications === false) return null;

  const body = summarize(detail);
  const title =
    kind === "approval"
      ? `${bot.name} needs approval`
      : kind === "question"
        ? `${bot.name} has a question`
        : kind === "takeover"
          ? `${bot.name} needs your hands`
          : kind === "routine-failed"
            ? `${bot.name}'s routine failed`
            : `${bot.name} finished`;

  // A "finished" with nothing to say is not worth a notification — the
  // badge in the sidebar already carries that much.
  if (kind === "done" && !body) return null;

  return { kind, botId: bot.id, botName: bot.name, threadId, title, body, ...extra };
}
