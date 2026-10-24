import { resolveLocale } from "@/lib/i18n";
import { effectiveLanguage, languageChoice } from "@/lib/language-preference";
import { locales } from "@/locales";

export const PRESENCE_MIN_INTERVAL_MS = 60_000;

/** The pack the app shows, worked out as App does rather than read from i18n, which a first ping can reach before App applies it. */
export function shownLanguage(serverDefault: string | undefined, choice: string | null = languageChoice()): string {
  return resolveLocale(effectiveLanguage(choice, serverDefault) || globalThis.navigator?.language, new Set(Object.keys(locales)));
}

/** The language lets the brief the server writes match the app. */
export function presenceBody(timeZone: string, language: string): { source: "desktop"; timeZone?: string; language: string } {
  return timeZone ? { source: "desktop", timeZone, language } : { source: "desktop", language };
}

export function duePing(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= PRESENCE_MIN_INTERVAL_MS;
}


export function openTarget(answer: unknown): { botId: string; threadId: string } | null {
  if (!answer || typeof answer !== "object") return null;
  const open = (answer as { open?: unknown }).open;
  if (!open || typeof open !== "object") return null;
  const { botId, threadId } = open as { botId?: unknown; threadId?: unknown };
  return typeof botId === "string" && typeof threadId === "string" && botId && threadId ? { botId, threadId } : null;
}
