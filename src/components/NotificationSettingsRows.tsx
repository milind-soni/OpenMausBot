import { hasWebPush, onWebPushChange, syncWebPush, usesWebPush } from "@/lib/web-push";
import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import {
  finishedNotificationsEnabled,
  setFinishedNotifications,
  setNotificationFeed,
  setNotificationSounds,
  useFinishedNotifications,
  useNotificationFeed,
  useNotificationSounds,
} from "@/lib/notification-preferences";
import { requestNotificationPermission } from "@/lib/notify";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function NotificationRows({ simple = false }: { simple?: boolean }) {
  return (
    <>
      <DeviceNotificationsRow simple={simple} />
      <NotificationSoundsRow simple={simple} />
      <NotificationFeedRow simple={simple} />
    </>
  );
}

const currentPermission = (): NotificationPermission => (typeof Notification !== "undefined" ? Notification.permission : "default");

/** A browser shows nothing until it is asked from a click; the person may also change the site permission elsewhere. */
export function DeviceNotificationsRow({ simple = false }: { simple?: boolean }) {
  const [permission, setPermission] = useState(currentPermission);
  const enabled = useFinishedNotifications();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setPermission(currentPermission());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const registered = useSyncExternalStore(onWebPushChange, hasWebPush, () => false);
  const active = enabled && (!usesWebPush() || registered);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (typeof Notification === "undefined") return null;

  const blocked = permission === "denied";
  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await requestNotificationPermission();
      if (!next) return;
      setPermission(next);
      if (next !== "granted") return;
      const on = permission !== "granted" || !active;
      await syncWebPush(on);
      setFinishedNotifications(on);
    } catch (cause) {
      setError(String(cause));
      setFinishedNotifications(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.deviceNotifications.title")}
      subtitle={error || t(blocked ? "settings.deviceNotifications.blocked" : usesWebPush() ? "settings.deviceNotifications.push" : simple ? "settings.simple.deviceNotifications" : "settings.deviceNotifications.subtitle")}
    >
      <Switch
        checked={permission === "granted" && active}
        disabled={blocked || busy}
        aria-label={t("settings.deviceNotifications.show")}
        onClick={() => void toggle()}
      />
    </SettingRow>
  );
}

export function NotificationSoundsRow({ simple = false }: { simple?: boolean }) {
  const enabled = useNotificationSounds();
  return (
    <SettingRow title={t("settings.notificationSounds.title")} subtitle={t(simple ? "settings.simple.notificationSounds" : "settings.notificationSounds.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.notificationSounds.play")}
        onClick={() => {
          setNotificationSounds(!enabled);
          if (usesWebPush() && Notification.permission === "granted" && finishedNotificationsEnabled()) void syncWebPush(true).catch(() => {});
        }}
      />
    </SettingRow>
  );
}

export function NotificationFeedRow({ simple = false }: { simple?: boolean }) {
  const enabled = useNotificationFeed();
  return (
    <SettingRow title={t("settings.notificationFeed.title")} subtitle={t(simple ? "settings.simple.notificationFeed" : "settings.notificationFeed.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.notificationFeed.show")}
        onClick={() => setNotificationFeed(!enabled)}
      />
    </SettingRow>
  );
}
