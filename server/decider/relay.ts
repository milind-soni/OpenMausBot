// What Cloud Pro's decision relay accepts through the included token
// (docs/cloud-pro.md, "Included Boat computers, voice and decisions"; the
// Admin checks the same): room routing's one request, the Settings key
// check, and each job's fixed contract in jobs.ts, within its size caps.
// Anything else (another question, other instructions, another state key, a
// larger state) is never sent through the included token: it goes only with
// the person's own key.
import { jevRequestBody, JEV_MAX_OPTIONS } from "./jev.ts";
import { JOB_CONTRACTS, OPTION_KEY_MAX, OPTION_TEXT_MAX, type JobContract } from "./jobs.ts";
import { ROOM_ROUTING_INSTRUCTIONS, ROOM_ROUTING_STATE_KEYS } from "./room-routing.ts";
import type { DeciderQuestion, DeciderSeam } from "./types.ts";

/** The Settings key check's fixed request. */
export const KEY_CHECK_STATE = { purpose: "OpenMausBot is checking that a decision-model key works." };
export const KEY_CHECK_QUESTION = "Is this a connection check?";

/** The relay's caps: the whole request body, and the state as JSON. Both
 * measured in UTF-8 bytes, which is never less than characters. */
export const RELAY_MAX_BODY_BYTES = 64 * 1024;
export const RELAY_MAX_STATE_BYTES = 24_000;

/** Where a request may use the included token: every job with a contract.
 * A job added later is not here until jobs.ts (and the Admin) has it. */
const RELAY_SEAMS: ReadonlySet<DeciderSeam> = new Set<DeciderSeam>(["roomRouting", "keyCheck", ...(Object.keys(JOB_CONTRACTS) as DeciderSeam[])]);
const ROOM_STATE_KEYS: ReadonlySet<string> = new Set(ROOM_ROUTING_STATE_KEYS);
const ROOM_STATE_REQUIRED = ROOM_ROUTING_STATE_KEYS.filter((key) => key !== "recent_messages");

export function relaySeam(seam: DeciderSeam): boolean {
  return RELAY_SEAMS.has(seam);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
};

/** Caller-supplied options: 2–255 of them, keys and meanings within size. */
function optionsFit(options: Record<string, string>): boolean {
  const entries = Object.entries(options);
  return entries.length >= 2 && entries.length <= JEV_MAX_OPTIONS &&
    entries.every(([key, text]) => key.length > 0 && key.length <= OPTION_KEY_MAX && typeof text === "string" && text.length <= OPTION_TEXT_MAX);
}

function contractFits(contract: JobContract, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
  if (!isRecord(state)) return false;
  const allowed = new Set(contract.stateKeys);
  if (!Object.keys(state).every((key) => allowed.has(key))) return false;
  if (!contract.required.every((key) => key in state)) return false;
  const ids = Object.keys(questions);
  if (contract.kind === "perItem") {
    const list = state[contract.listKey];
    if (!Array.isArray(list) || list.length < 1 || list.length > contract.maxItems || ids.length !== list.length) return false;
    return list.every((_, index) => {
      const question = questions[`${contract.idPrefix}${index}`];
      return question?.type === "yesno" && question.instructions === contract.instructionsFor(index) && !question.criteria;
    });
  }
  const question = questions.answer;
  if (ids.length !== 1 || !question || question.type !== contract.type || question.instructions !== contract.instructions) return false;
  if (question.type === "choice") return contract.options ? sameRecord(contract.options, question.options) : optionsFit(question.options);
  if (question.type === "score") return Boolean(contract.levels) && question.levels.length === contract.levels!.length &&
    question.levels.every((level, index) => level === contract.levels![index]);
  return !question.criteria;
}

function shapeFits(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
  const contract = (JOB_CONTRACTS as Partial<Record<DeciderSeam, JobContract>>)[seam];
  if (contract) return contractFits(contract, state, questions);
  const ids = Object.keys(questions);
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
  // Any other seam: the relay takes nothing from it.
  return false;
}

/** Whether this exact request may go through the included token. */
export function relayAccepts(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
  try {
    if (!shapeFits(seam, state, questions)) return false;
    return Buffer.byteLength(JSON.stringify(state)) <= RELAY_MAX_STATE_BYTES &&
      Buffer.byteLength(JSON.stringify(jevRequestBody(state, questions))) <= RELAY_MAX_BODY_BYTES;
  } catch {
    return false;
  }
}
