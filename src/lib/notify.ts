import type { Notification } from "../../shared/notification";
import { plainPreviewText } from "../../shared/plain-preview";
import { notificationSound, type SoundOutcome } from "./app-sounds";
import { finishedNotificationsEnabled } from "./notification-preferences";

export type NotifyFrame = Notification & { id?: string; read?: boolean };

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** On a team's page in the desktop app, its name: notifications then say which place they come from ("Acme · Scout"). */
let placeName: string | null = null;
export function setNotificationPlace(name: string | null) {
  placeName = name;
}

/** Call from the click: browsers may reject a permission request made later from an SSE frame. Resolves to the permission now in force. */
export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (typeof Notification === "undefined") return null;
  try {
    return Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  } catch {
    return Notification.permission;
  }
}

export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
) {
  const viewing = typeof document !== "undefined" && document.hasFocus() && visibleThreadId === frame.threadId;
  const sound = notificationSound(frame, viewing);
  if (typeof Notification === "undefined") return;
  if (frame.kind === "done" && !finishedNotificationsEnabled()) return;
  if (frame.kind !== "spend" && viewing) return;
  if (Notification.permission !== "granted") return;
  if (typeof sound === "string") showBanner(frame, onOpen, avatarUrl, sound);
  else void sound.then((outcome) => showBanner(frame, onOpen, avatarUrl, outcome));
}

/** The banner chimes only when the app wanted a sound and could not play it; otherwise the app spoke, or chose quiet. */
function showBanner(frame: NotifyFrame, onOpen: (target: NotificationTarget) => void, avatarUrl: string | null | undefined, sound: SoundOutcome) {
  const spend = frame.kind === "spend";
  const title = placeName ? `${placeName} · ${frame.title}` : frame.title;
  // Entries saved before the harness spoke plain text still carry Markdown.
  const body = plainPreviewText(frame.body);
  const options: NotificationOptions = {
    body,
    ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
    ...(spend ? { tag: "openmausbot:spend", icon: undefined } : {}),
    ...(sound === "unplayable" ? {} : { silent: true }),
  };
  const shownByPage = () => {
    new Notification(title, options).onclick = () => {
      window.focus();
      onOpen({ botId: frame.botId, threadId: frame.threadId });
    };
  };
  const desktop = window.ogb?.desktopNotifications;
  if (!desktop) return shownByPage();
  void desktop.show({
    title, body, tag: options.tag, silent: options.silent === true, picture: options.icon, botId: frame.botId, threadId: frame.threadId,
  }).then((shown) => { if (!shown) shownByPage(); }, shownByPage);
}
