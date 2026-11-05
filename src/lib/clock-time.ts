import { activeLocale, intlLocale, t } from "@/lib/i18n";

const twentyFourHour = new Map<string, boolean>();

export const namesLocale = (): string => (activeLocale() === "en" ? "en-US" : intlLocale());

export function clockOptions(locale: string, wholeHour = false): Intl.DateTimeFormatOptions {
  if (activeLocale() === "en") return wholeHour ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" };
  if (!twentyFourHour.has(locale)) {
    const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    twentyFourHour.set(locale, cycle === "h23" || cycle === "h24");
  }
  if (twentyFourHour.get(locale)) return { hour: "2-digit", minute: "2-digit" };
  return wholeHour ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" };
}

let timeFormat: { locale: string; clock: Intl.DateTimeFormat } | undefined;

export function formatTime(at: number) {
  const date = new Date(at);
  // toLocaleTimeString's output, where Intl.DateTimeFormat.format would throw
  if (Number.isNaN(date.getTime())) return t("time.invalid");
  const locale = intlLocale();
  if (timeFormat?.locale !== locale) timeFormat = { locale, clock: new Intl.DateTimeFormat(locale, clockOptions(locale)) };
  return timeFormat.clock.format(date);
}
