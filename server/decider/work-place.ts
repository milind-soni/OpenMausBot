// The decision model's work place: where a bot on "Works on: Auto" should do
// what this message asks, among the places actually set up here.
//
// One Choice (WORK_PLACE in jobs.ts) over the places the caller says Auto
// could reach right now, each with a plain meaning, and the state
// { message, bot }. Asked only when the conversation is not pinned and at
// least two places are there to choose between; a person's pin and a bot's
// explicit "Works on" never reach this module.
//
// Acting on it: a place at p >= 0.7 is tried first this turn, through the
// same Auto mount (so its first screen use pins the conversation as Auto
// does today). Anything less sure, and any failure at all, keeps today's
// Auto order. Nothing here throws.
import type { Decider } from "./index.ts";
import { WORK_PLACE } from "./jobs.ts";
import type { DeciderFailure } from "./types.ts";

export const WORK_PLACE_MIN_PROBABILITY = 0.7;

/** Option keys, stable across releases: they name places, not backends. */
export type WorkPlace = "this_computer" | "local_vm" | "cloud_computer";

const PLACE_MEANINGS: Record<WorkPlace, string> = {
  this_computer: "This computer: the person's own Mac or PC, with their apps, files and signed-in browser.",
  local_vm: "Local VM: a separate, isolated desktop running on this machine, away from the person's own apps and files.",
  cloud_computer: "Cloud computer: a remote desktop in the cloud with its own browser, which keeps working when this machine sleeps.",
};

const MESSAGE_MAX = 1_500;
const BOT_MAX = 400;

export interface WorkPlaceInput {
  message: string;
  bot: { name: string; description?: string };
  /** The places Auto could reach now, in any order. */
  places: readonly WorkPlace[];
}

export type WorkPlaceChoice =
  | { kind: "place"; place: WorkPlace; probability: number }
  | { kind: "fallback"; reason: DeciderFailure | "low_confidence" | "no_choice" };

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function workPlaceRequest(input: WorkPlaceInput) {
  const options = {} as Record<WorkPlace, string>;
  for (const place of input.places) options[place] = PLACE_MEANINGS[place];
  const description = input.bot.description?.trim();
  const bot = clip(description ? `${input.bot.name}: ${description}` : input.bot.name, BOT_MAX);
  return {
    state: { message: clip(input.message, MESSAGE_MAX), ...(bot ? { bot } : {}) },
    question: { instructions: WORK_PLACE.instructions, options },
  };
}

/** Ask once and turn the answer into a place to try first. Never throws. */
export async function decideWorkPlace(
  decider: Pick<Decider, "choose">,
  input: WorkPlaceInput,
  options: { signal?: AbortSignal } = {},
): Promise<WorkPlaceChoice> {
  try {
    const places = [...new Set(input.places)].filter((place) => place in PLACE_MEANINGS);
    if (places.length < 2 || !input.message.trim()) return { kind: "fallback", reason: "no_choice" };
    const { state, question } = workPlaceRequest({ ...input, places });
    const result = await decider.choose("workPlace", state, question, { timeoutMs: WORK_PLACE.timeoutMs, signal: options.signal });
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    const { choice, pTop } = result.answers;
    if (!places.includes(choice)) return { kind: "fallback", reason: "malformed" };
    if (pTop < WORK_PLACE_MIN_PROBABILITY) return { kind: "fallback", reason: "low_confidence" };
    return { kind: "place", place: choice, probability: pTop };
  } catch {
    return { kind: "fallback", reason: "malformed" };
  }
}
