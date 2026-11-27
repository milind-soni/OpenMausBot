export function localizedRelativeTime(at: number, locale: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 45) return formatter.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return formatter.format(-days, "day");
  return new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
