import { formatTime } from "@/lib/clock-time";
import { t } from "@/lib/i18n";

/** "Works once, until 11:14": a code's end as a clock time, never a countdown. */
export function codeUntil(expiresAt: number): string {
  return t("pairing.worksOnceUntil", { time: formatTime(expiresAt) });
}

export function lastSeen(lastSeenAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - lastSeenAt) / 60_000));
  if (minutes < 1) return t("remote.serverPairing.justNow");
  if (minutes < 60) return t("remote.serverPairing.minutesAgo", { minutes });
  if (minutes < 1440) return t("remote.serverPairing.hoursAgo", { hours: Math.round(minutes / 60) });
  return t("remote.serverPairing.daysAgo", { days: Math.round(minutes / 1440) });
}
