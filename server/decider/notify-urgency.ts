// Notification urgency (jobs.ts, NOTIFY_URGENCY): does a "finished" kind of
// notification need to buzz, or can it arrive quietly?
//
// One Choice over the contract's fixed options (urgent, later). The state
// is the notification as the person would see it: kind, bot, title, body.
//
// Acting on it: "later" at p >= 0.7 marks the notification `quiet`, and
// clients show it without a sound. Only kinds that report finished work are
// asked about; an approval, a question, a takeover, a failure or anything
// else that needs a person is never quietened, and nothing here makes a
// notification louder. Anything less sure, and any failure, sends it as
// today. Nothing here throws.
import type { Notification, NotifyKind } from "../../shared/notification.ts";
import type { Decider } from "./index.ts";
import { NOTIFY_URGENCY } from "./jobs.ts";

/** A "later" at least this sure arrives quietly. */
export const QUIET_MIN_PROBABILITY = 0.7;
/** The kinds that only report: work finished, results in. Everything else
 * is someone waiting on the person or something gone wrong. */
export const QUIETABLE_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>(["done", "delegation-settled"]);

const NAME_MAX = 80;
const TITLE_MAX = 200;
const BODY_MAX = 1_000;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Whether a notification may be asked about at all. */
export function notificationQuietable(notification: Notification): boolean {
  return QUIETABLE_KINDS.has(notification.kind) && notification.quiet !== true;
}

export function notifyUrgencyRequest(notification: Notification) {
  const state = {
    notification: {
      kind: notification.kind,
      bot: clip(notification.botName, NAME_MAX),
      title: clip(notification.title, TITLE_MAX),
      body: clip(notification.body, BODY_MAX),
    },
  };
  return { state, question: { instructions: NOTIFY_URGENCY.instructions, options: { ...NOTIFY_URGENCY.options! } as Record<"urgent" | "later", string> } };
}

/** The notification to send: the same one, or a copy marked quiet. Never
 * throws, and never returns a louder notification than it was given. */
export async function decideNotificationQuiet(
  decider: Pick<Decider, "choose">,
  notification: Notification,
  options: { timeoutMs?: number } = {},
): Promise<Notification> {
  try {
    if (!notificationQuietable(notification)) return notification;
    const { state, question } = notifyUrgencyRequest(notification);
    const result = await decider.choose("notifyUrgency", state, question, { timeoutMs: options.timeoutMs ?? NOTIFY_URGENCY.timeoutMs });
    if (!result.ok) return notification;
    const { choice, pTop } = result.answers;
    if (choice !== "later" || typeof pTop !== "number" || !(pTop >= QUIET_MIN_PROBABILITY)) return notification;
    return { ...notification, quiet: true };
  } catch {
    return notification;
  }
}
