// Suggested replies: the one short line a person might send next, offered in an empty composer after a bot's reply.

/** The fields of a transcript row the suggestion reads; the server's stored rows and the client's both fit. */
export interface SuggestionRow {
  id: string;
  role: "bot" | "user";
  kind: string;
  text?: string;
  automated?: unknown;
  aside?: unknown;
  /** Another bot's ask, not the person's. */
  peerAsk?: unknown;
  from?: unknown;
  stoppedBy?: unknown;
}

export interface LastExchange {
  /** The person's last message. */
  ask: string;
  askId: string;
  reply: string;
  /** The reply's row: a suggestion is for this reply only. */
  replyId: string;
}

/** Rows a finished turn may leave after its reply that ask nothing of the person. */
const QUIET_KINDS: ReadonlySet<string> = new Set(["activity", "digest", "screen"]);

/** Fields that make a row something the person answers in place (a card, a choice, a wait) rather than by typing. */
const INTERACTIVE_FIELDS = [
  "card", "widget", "app", "connector", "secret", "signIn", "routineRun", "goalRun", "burst", "call", "setupOffer", "setupChoices",
  "setupChoicesPending", "setupRequest", "settingsCard", "setupSuggestion", "helperIntro", "helperFollowup", "savedSteps",
  "waitId", "waitRequest", "checkBack", "handoff", "bugReport", "serverCard", "webhookPost",
] as const;

const ASK_MAX = 1_500;
const REPLY_MAX = 3_000;
const TRIVIAL_CHARS = 20;
const TRIVIAL_WORDS = 4;
export const SUGGESTION_MAX_WORDS = 12;
const SUGGESTION_MAX_CHARS = 120;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

function interactive(row: SuggestionRow): boolean {
  const fields = row as unknown as Record<string, unknown>;
  return !(row.kind === "text" || QUIET_KINDS.has(row.kind)) || INTERACTIVE_FIELDS.some((field) => fields[field] !== undefined && fields[field] !== false);
}

/** The person's last message and the bot's finished plain reply to it, or null when there is nothing to suggest after:
 * no reply yet, a card or choice to answer, an automated or another bot's ask, a stopped reply, or one too short to
 * answer ("Done."). */
export function lastExchange(rows: readonly SuggestionRow[]): LastExchange | null {
  const askAt = rows.findLastIndex((row) => row.role === "user" && row.kind === "text" && !row.aside);
  if (askAt < 0) return null;
  const ask = rows[askAt]!;
  if (ask.automated || ask.peerAsk || ask.from || !ask.text?.trim()) return null;
  const after = rows.slice(askAt + 1);
  if (!after.length || after.some((row) => row.role !== "bot" || interactive(row))) return null;
  const reply = after.findLast((row) => row.kind === "text");
  const text = reply?.text?.trim();
  if (!reply || reply.stoppedBy || !text || text.length < TRIVIAL_CHARS || words(text) < TRIVIAL_WORDS) return null;
  return { ask: ask.text.trim().slice(0, ASK_MAX), askId: ask.id, reply: text.length > REPLY_MAX ? `…${text.slice(-REPLY_MAX)}` : text, replyId: reply.id };
}

/** The model's answer as one short line, or null when it gave none that fits. */
export function cleanSuggestion(raw: string | null | undefined): string | null {
  const line = (raw ?? "").split("\n").map((one) => one.trim()).find(Boolean);
  if (!line) return null;
  const text = line
    .replace(/^(?:[-*•>]\s*|\d+[.)]\s*)/, "")
    .replace(/^(?:suggestion|reply|next)\s*:\s*/i, "")
    .replace(/^["'“”‘’«»「『]+|["'“”‘’«»」』]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^none\.?$/i.test(text)) return null;
  if (text.length > SUGGESTION_MAX_CHARS || words(text) > SUGGESTION_MAX_WORDS + 2) return null;
  return text;
}
