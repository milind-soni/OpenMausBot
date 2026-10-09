// The current time, as one short line in front of every turn's message.
// Bots had no clock of their own: a model knows only its training cutoff,
// Claude Code and Codex add the date at most and never the time of day, the
// chat API engines add nothing, and the recent-work brief says "today 16:40"
// without saying which day today is. The line is stamped at dispatch, so a long
// conversation's next turn carries a fresh one instead of a copy frozen when
// the session started.
//
// It rides the turn text, like automatic recall, never the system prompt:
// the stable half must stay byte-identical for the cached prefix and the
// spawned CLI, and the volatile half is re-sent whole whenever any part of it
// changes, which a clock would do on every turn. A turn's message is new
// input anyway, so the line costs only its own few tokens.

/** The host's IANA timezone, the same source the routine scheduler uses. A
 * runtime that reports none reads as UTC. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const parts = (at: number, timeZone: string) => {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => formatted.find((entry) => entry.type === type)?.value ?? "";
  return { part, timeZone };
};

/** How the line opens. */
export const TURN_CLOCK_LEAD = "Current time when this message was sent: ";

/** "Current time when this message was sent: Thursday, 2026-10-08 19:48
 * Asia/Baghdad (UTC+03:00)." An unknown timezone falls back to UTC rather
 * than failing the turn. "when this message was sent" keeps the lines that
 * earlier turns left in a native session's history true as they age. */
export function turnClockLine(at: number, timeZone: string): string {
  let read: ReturnType<typeof parts>;
  try {
    read = parts(at, timeZone);
  } catch {
    read = parts(at, "UTC");
  }
  const { part } = read;
  // longOffset spells UTC itself as a bare "GMT"
  // and some ICU builds write the minus sign as U+2212
  const offset = part("timeZoneName").replace(/^GMT/, "").replace("\u2212", "-") || "+00:00";
  return `${TURN_CLOCK_LEAD}${part("weekday")}, ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${read.timeZone} (UTC${offset}).`;
}

/** Whether the person's own text takes the line. An empty text (an image
 * alone) and a slash command do not: a prefix would turn an engine's own
 * command into plain prose. Decided on what the person sent, before any
 * replay or unseen-messages context is put in front of it. */
export function takesTurnClock(text: string): boolean {
  return Boolean(text.trim()) && !text.trimStart().startsWith("/");
}

/** The clock line in front of a turn's text, unless the text itself is one
 * that skips it (see takesTurnClock). An empty clock leaves the text as is. */
export function withTurnClock(clock: string, text: string): string {
  if (!clock || !takesTurnClock(text)) return text;
  return `${clock}\n\n${text}`;
}
