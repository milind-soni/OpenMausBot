import { knownLocales, resolveLocale } from "@/lib/i18n";
import { effectiveLanguage, languageChoice } from "@/lib/language-preference";

export const PRESENCE_MIN_INTERVAL_MS = 60_000;

/** The pack the app shows, worked out as App does rather than read from i18n, which a first ping can reach before App applies it. */
export function shownLanguage(serverDefault: string | undefined, choice: string | null = languageChoice()): string {
  return resolveLocale(effectiveLanguage(choice, serverDefault) || globalThis.navigator?.language, knownLocales());
}

/** The language lets the brief the server writes match the app; the open chat lets the server get it ready to answer, and
 * `typing` (a key in its composer) says an answer is on its way. */
export function presenceBody(timeZone: string, language: string, threadId?: string, typing = false): { source: "desktop"; timeZone?: string; language: string; threadId?: string; typing?: true } {
  return { source: "desktop", ...(timeZone ? { timeZone } : {}), language, ...(threadId ? { threadId } : {}), ...(threadId && typing ? { typing: true } : {}) };
}

export function duePing(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= PRESENCE_MIN_INTERVAL_MS;
}

/** A key pressed in a chat's composer. */
export function composerKey(event: Pick<Event, "type" | "target"> | undefined): boolean {
  const target = event?.target as { closest?: (selector: string) => unknown } | null | undefined;
  return event?.type === "keydown" && typeof target?.closest === "function" && Boolean(target.closest("[data-composer-row]"));
}

/** Typing in a conversation is told at once, then once a minute at most while typing goes on there. */
export function dueTyping(last: { threadId: string; at: number } | null, threadId: string, now: number): boolean {
  return !last || last.threadId !== threadId || now - last.at >= PRESENCE_MIN_INTERVAL_MS;
}


export function openTarget(answer: unknown): { botId: string; threadId: string } | null {
  if (!answer || typeof answer !== "object") return null;
  const open = (answer as { open?: unknown }).open;
  if (!open || typeof open !== "object") return null;
  const { botId, threadId } = open as { botId?: unknown; threadId?: unknown };
  return typeof botId === "string" && typeof threadId === "string" && botId && threadId ? { botId, threadId } : null;
}
