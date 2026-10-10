// What Cloud Pro's decision relay accepts through the included token
// (docs/cloud-pro.md, "Included Boat computers, voice and decisions"; the
// Admin checks the same): room routing's one request and the Settings key
// check, within its size caps. Anything else (another job, another question,
// a larger state) is never sent through the included token: it goes only
// with the person's own key, until the relay accepts it too.
import { jevRequestBody } from "./jev.ts";
import { ROOM_ROUTING_INSTRUCTIONS, ROOM_ROUTING_STATE_KEYS } from "./room-routing.ts";
import type { DeciderQuestion, DeciderSeam } from "./types.ts";

/** The Settings key check's fixed request. */
export const KEY_CHECK_STATE = { purpose: "OpenMausBot is checking that a decision-model key works." };
export const KEY_CHECK_QUESTION = "Is this a connection check?";

/** The relay's caps: the whole request body, and the state as JSON. Both
 * measured in UTF-8 bytes, which is never less than characters. */
export const RELAY_MAX_BODY_BYTES = 64 * 1024;
export const RELAY_MAX_STATE_BYTES = 24_000;

/** Where a request may use the included token. A job added later is not here
 * until the relay accepts it. */
const RELAY_SEAMS: ReadonlySet<DeciderSeam> = new Set<DeciderSeam>(["roomRouting", "keyCheck"]);
const ROOM_STATE_KEYS: ReadonlySet<string> = new Set(ROOM_ROUTING_STATE_KEYS);
const ROOM_STATE_REQUIRED = ROOM_ROUTING_STATE_KEYS.filter((key) => key !== "recent_messages");

export function relaySeam(seam: DeciderSeam): boolean {
  return RELAY_SEAMS.has(seam);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function shapeFits(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
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
