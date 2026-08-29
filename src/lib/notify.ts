// Desktop notifications, driven by the harness's {kind:"notify"} frames.
// The server decides *whether* something is worth an interruption (it owns
// the per-bot toggle); this only decides how to show it here.
import type { Notification } from "../../server/notify.ts";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** Ask while handling the settings click. Browsers may reject permission
 * requests that are triggered later by an incoming SSE frame. */
export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return null;
  return Notification.requestPermission();
}

/** The identity a notification groups under: one bot, wherever it was
 * working. Keyed by bot rather than thread so a single bot running across
 * tasks and rooms coalesces into one stack instead of stacking banners. */
export interface NotificationBotIdentity {
  id: string;
}

/** Presentation options for one bot's notifications: the stable per-bot
 * coalescing key platforms replace on (`tag`) and the canonical application
 * mark. Bot avatars belong inside the app; OS banners carry product identity. */
export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: "./app-icon.svg" };
}

/** Show one, unless the app is already in front of the user — a banner over
 * the window you are looking at is noise, and the chat itself already shows
 * the card. */
export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
) {
  if (typeof Notification === "undefined") return;
  if (document.hasFocus()) return;

  const open = () => {
    window.focus();
    onOpen({ botId: frame.botId, threadId: frame.threadId });
  };

  if (Notification.permission === "granted") {
    const options: NotificationOptions = {
      body: frame.body,
      ...buildNotificationOptions({ id: frame.botId }),
    };
    new Notification(frame.title, options).onclick = open;
  }
}
