import { t } from "@/lib/i18n";

export function minutesLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

export function lastSeen(lastSeenAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - lastSeenAt) / 60_000));
  if (minutes < 1) return t("remote.serverPairing.justNow");
  if (minutes < 60) return t("remote.serverPairing.minutesAgo", { minutes });
  if (minutes < 1440) return t("remote.serverPairing.hoursAgo", { hours: Math.round(minutes / 60) });
  return t("remote.serverPairing.daysAgo", { days: Math.round(minutes / 1440) });
}
