import { api } from "../state/api";
import { notificationSoundsEnabled } from "./notification-preferences";

export function usesWebPush() {
  return typeof window !== "undefined" && !window.ogb?.desktopNotifications &&
    window.matchMedia?.("(display-mode: standalone)").matches === true &&
    "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

let subscribed = false;
const listeners = new Set<() => void>();
export function onWebPushChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function setSubscribed(value: boolean) {
  subscribed = value;
  for (const listener of listeners) listener();
}
export const hasWebPush = () => subscribed;
let pending: Promise<void> = Promise.resolve();

export function syncWebPush(enabled: boolean): Promise<void> {
  if (!usesWebPush()) return Promise.resolve();
  const run = async () => {
    if (!enabled) {
      const worker = await navigator.serviceWorker.getRegistration("/");
      const subscription = await worker?.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
      setSubscribed(false);
      await api("/api/push/web", { method: "DELETE" });
      return;
    }
    await navigator.serviceWorker.register("/bot-notifications.js");
    const worker = await navigator.serviceWorker.ready;
    const { publicKey } = await api<{ publicKey: string }>("/api/push/web");
    let subscription = await worker.pushManager.getSubscription();
    if (subscription && subscription.options.applicationServerKey) {
      const encoded = btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey)))
        .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      if (encoded !== publicKey) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    await api("/api/push/web", { method: "PUT", body: JSON.stringify({ subscription, silent: !notificationSoundsEnabled() }) });
    setSubscribed(true);
  };
  pending = pending.catch(() => {}).then(run);
  return pending;
}
