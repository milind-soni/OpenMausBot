// A failed pass of the one-time move to My Cloud (one-home.mjs), as the Admin may be told it (move-status.mjs): where
// it failed, a stable code, and the journal's sentence with anything that could be the person's own words taken out.
import { unanswered } from "./cloud-send.mjs";

/** The phases a pass can fail in: one-home.mjs's own, before and at the switch. */
export const FAILURE_PHASES = Object.freeze(["copy", "freeze", "final", "check", "switch"]);
export const FAILURE_CODES = Object.freeze(["rate_limited", "unanswered", "session", "local", "freeze", "no_cloud", "unreachable", "refused", "incomplete",
  "not_ready", "other_account", "switch_refused", "error"]);
/** The codes one-home.mjs tags its own failures with. */
const TAGGED = new Set(["incomplete", "not_ready", "other_account", "switch_refused"]);
const SENT = new Map([["local", "local"], ["no_cloud", "no_cloud"], ["unreachable", "unreachable"], ["refused", "refused"], ["invalid", "refused"]]);

/** The Admin's "too many requests" (429) anywhere in an error's causes, as an owner session's pairing refuses it. */
export function rateLimited(error) {
  for (let at = error, depth = 0; at && depth < 5; at = at.cause, depth++) if (at.status === 429) return true;
  return false;
}

/** Why a pass failed, as one of FAILURE_CODES. A freeze only ever asks this computer's own server. */
export function failureCode(error, phase) {
  if (phase === "freeze") return "freeze";
  if (TAGGED.has(error?.code)) return error.code;
  if (rateLimited(error)) return "rate_limited";
  if (unanswered(error)) return "unanswered";
  if (error?.code === "session") return "session";
  return SENT.get(error?.code) ?? "error";
}

/** The journal's record of this failure, counted on from the one before it (`previous`) until the move is done. */
export function failureOf(error, phase, previous, at) {
  const count = Number.isSafeInteger(previous?.count) && previous.count > 0 ? previous.count + 1 : 1;
  const since = Number.isSafeInteger(previous?.since) ? previous.since : at;
  return { phase, code: failureCode(error, phase), count, since, at };
}

const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(^|[\s(])'[^'\s][^']*'(?=[\s.,;:!?)]|$)/gu;
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S+|[^\s@"'`]+@[^\s@"'`]+\.[^\s@"'`]+/giu;
const PATH = /(?:[A-Za-z]:)?(?:[\\/][^\s\\/"'`]+){2,}[\\/]?/gu;
const TOKEN = /[A-Za-z0-9_+/=-]{40,}/gu;
/** What My Cloud itself said can name the person's things: only that it said something is kept. */
const SAID = /\bsaid:.*$/su;
export const SENTENCE_MAX = 200;

/**
 * A failure's sentence fit to leave this computer: one line of at most SENTENCE_MAX characters, with what My Cloud said in
 * its own words, anything quoted, web and email addresses, file paths and long tokens each replaced by "…". Ids stay; the
 * person's words, names and secrets never do. Null when there is nothing left to say.
 */
export function safeSentence(value) {
  if (typeof value !== "string") return null;
  const line = value.replace(/\p{Cc}+/gu, " ").replace(SAID, "said: …").replace(QUOTED, (_match, lead = "") => `${lead}…`)
    .replace(ADDRESS, "…").replace(PATH, "…").replace(TOKEN, "…").replace(/\s+/gu, " ").trim();
  if (!line) return null;
  return line.length <= SENTENCE_MAX ? line : `${line.slice(0, SENTENCE_MAX - 1).trimEnd()}…`;
}
