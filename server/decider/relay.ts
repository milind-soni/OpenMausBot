// Anything the relay does not accept never goes through the included token: only with the person's own key. Cloud's
// Admin runs the same checks on its side, from the same fixtures (fixtures/relay-seams.json): change both together.
import { jevRequestBody } from "./jev.ts";
import { INBOX_DISMISSED_MAX, INBOX_EMAIL_KEYS, INBOX_TRIAGE_INSTRUCTIONS, INBOX_TRIAGE_OPTIONS, INBOX_TRIAGE_STATE_KEYS } from "./inbox-triage.ts";
import { ROOM_ROUTING_INSTRUCTIONS, ROOM_ROUTING_STATE_KEYS } from "./room-routing.ts";
import type { DeciderQuestion, DeciderSeam } from "./types.ts";

export const KEY_CHECK_STATE = { purpose: "OpenMausBot is checking that a decision-model key works." };
export const KEY_CHECK_QUESTION = "Is this a connection check?";

/** Measured in UTF-8 bytes. */
export const RELAY_MAX_BODY_BYTES = 64 * 1024;
export const RELAY_MAX_STATE_BYTES = 24_000;
/** A bot's own question (`decide` tool): generous, but bounded so the relay can count it. */
export const BOT_DECIDE_LIMITS = { questions: 8, options: 20, levels: 10, id: /^[A-Za-z0-9_.-]{1,64}$/, instructions: 1_000, meaning: 300 } as const;

/** A job added later stays out until the relay accepts it. */
const RELAY_SEAMS: ReadonlySet<DeciderSeam> = new Set<DeciderSeam>(["roomRouting", "keyCheck", "inboxTriage", "botDecide"]);
const ROOM_STATE_KEYS: ReadonlySet<string> = new Set(ROOM_ROUTING_STATE_KEYS);
const ROOM_STATE_REQUIRED = ROOM_ROUTING_STATE_KEYS.filter((key) => key !== "recent_messages");
const INBOX_STATE_KEYS: ReadonlySet<string> = new Set(INBOX_TRIAGE_STATE_KEYS);
const INBOX_EMAIL: ReadonlySet<string> = new Set(INBOX_EMAIL_KEYS);
const INBOX_DETAIL_MAX = 300;

export function relaySeam(seam: DeciderSeam): boolean {
  return RELAY_SEAMS.has(seam);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown, max: number): boolean => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function sameOptions(options: Record<string, string>, expected: Record<string, string>): boolean {
  const keys = Object.keys(options);
  return keys.length === Object.keys(expected).length && keys.every((key) => options[key] === expected[key]);
}

function inboxStateFits(state: unknown): boolean {
  if (!isRecord(state) || !Object.keys(state).every((key) => INBOX_STATE_KEYS.has(key))) return false;
  const email = state.email;
  if (!isRecord(email) || !Object.keys(email).every((key) => INBOX_EMAIL.has(key)) || !Object.values(email).every((value) => typeof value === "string")) return false;
  if (state.details !== undefined && (!isRecord(state.details) || !Object.values(state.details).every((value) =>
    value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= INBOX_DETAIL_MAX)))) return false;
  const dismissed = state.dismissed_senders;
  return dismissed === undefined || (Array.isArray(dismissed) && dismissed.length <= INBOX_DISMISSED_MAX && dismissed.every((from) => typeof from === "string"));
}

function botQuestionFits(id: string, question: DeciderQuestion): boolean {
  const limits = BOT_DECIDE_LIMITS;
  if (!limits.id.test(id) || !shortText(question.instructions, limits.instructions)) return false;
  if (question.type === "choice") {
    const entries = Object.entries(question.options ?? {});
    return entries.length >= 2 && entries.length <= limits.options && entries.every(([key, meaning]) => limits.id.test(key) && shortText(meaning, limits.meaning));
  }
  if (question.type === "score") return Array.isArray(question.levels) && question.levels.length >= 2 && question.levels.length <= limits.levels && question.levels.every((level) => shortText(level, limits.meaning));
  if (question.type !== "yesno") return false;
  const criteria = question.criteria;
  return criteria === undefined || (isRecord(criteria) && Object.keys(criteria).every((key) => key === "yes" || key === "no") &&
    Object.values(criteria).every((text) => text === undefined || shortText(text, limits.meaning)));
}

function shapeFits(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
  const ids = Object.keys(questions);
  if (seam === "botDecide") {
    return ids.length >= 1 && ids.length <= BOT_DECIDE_LIMITS.questions && ids.every((id) => botQuestionFits(id, questions[id]!)) &&
      (typeof state === "string" ? state.trim().length > 0 : isRecord(state) || Array.isArray(state));
  }
  const question = questions.answer;
  if (ids.length !== 1 || !question) return false;
  if (seam === "keyCheck") {
    return question.type === "yesno" && question.instructions === KEY_CHECK_QUESTION && !question.criteria &&
      JSON.stringify(state) === JSON.stringify(KEY_CHECK_STATE);
  }
  if (seam === "roomRouting") {
    return question.type === "choice" && question.instructions === ROOM_ROUTING_INSTRUCTIONS && isRecord(state) &&
      Object.keys(state).every((key) => ROOM_STATE_KEYS.has(key)) && ROOM_STATE_REQUIRED.every((key) => key in state);
  }
  if (seam === "inboxTriage") {
    return question.type === "choice" && question.instructions === INBOX_TRIAGE_INSTRUCTIONS && sameOptions(question.options, INBOX_TRIAGE_OPTIONS) &&
      inboxStateFits(state);
  }
  return false;
}

export function relayAccepts(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
  try {
    if (!shapeFits(seam, state, questions)) return false;
    return Buffer.byteLength(JSON.stringify(state)) <= RELAY_MAX_STATE_BYTES &&
      Buffer.byteLength(JSON.stringify(jevRequestBody(state, questions))) <= RELAY_MAX_BODY_BYTES;
  } catch {
    return false;
  }
}
