// Task outcome: did a routine whose engine turn ended "ok" actually get its
// task done? The engine's ok only says the turn ran to the end; a reply that
// says "I couldn't sign in" is still an ok turn, and was reported "finished".
//
// One Choice (TASK_OUTCOME in jobs.ts: done / blocked / nothing) over the
// routine's task and the bot's final reply. Acting on it: "blocked" at
// p >= 0.75 turns the "finished" notification into a "needs attention" one
// and marks the run so its history says so. The run stays completed: this
// never retries it, fails it or counts it against the routine's failure
// streak. Anything else, and any failure at all, keeps today's "finished".
// Nothing here throws.
import { redactSecretsInText } from "../redact.ts";
import type { Decider } from "./index.ts";
import { RELAY_MAX_STATE_BYTES } from "./relay.ts";
import { TASK_OUTCOME } from "./jobs.ts";
import type { DeciderFailure } from "./types.ts";

/** A wrong "needs attention" costs a person a look at a run that was fine;
 * a missed one costs what today costs. Only a clear "blocked" acts. */
export const TASK_OUTCOME_MIN_PROBABILITY = 0.75;

const NAME_MAX = 120;
const TASK_MAX = 1_500;
/** The conclusion of a reply is at its end, so a long reply keeps its end. */
const REPLY_MAX = 6_000;

type OutcomeChoice = "done" | "blocked" | "nothing";
/** The contract's fixed options, verbatim: the relay checks them exactly. */
const OUTCOME_OPTIONS = TASK_OUTCOME.options as Readonly<Record<OutcomeChoice, string>>;

export interface TaskOutcomeInput {
  /** The routine's name and the instructions it ran with. */
  name: string;
  prompt?: string;
  /** What the bot said at the end of the run. */
  reply: string;
}

export type TaskOutcome =
  | { kind: "blocked"; probability: number }
  | { kind: "fallback"; reason: DeciderFailure | "low_confidence" | "not_blocked" | "no_reply" };

const flat = (value: string) => value.replace(/\s+/g, " ").trim();

function clipStart(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clipEnd(value: string, max: number): string {
  return value.length > max ? `…${value.slice(value.length - (max - 1))}` : value;
}

export function taskOutcomeRequest(input: TaskOutcomeInput) {
  const name = clipStart(flat(input.name), NAME_MAX);
  const prompt = flat(input.prompt ?? "");
  const task = clipStart(prompt ? `${name}: ${prompt}` : name, TASK_MAX);
  let reply = clipEnd(flat(redactSecretsInText(input.reply)), REPLY_MAX);
  // Characters bound the size for ordinary text; this bounds it in bytes
  // too, for a reply of wide characters, so Cloud Pro's relay still takes it.
  while (reply.length > 1 && Buffer.byteLength(JSON.stringify({ task, final_reply: reply })) > RELAY_MAX_STATE_BYTES) {
    reply = clipEnd(reply, Math.floor(reply.length / 2));
  }
  const state = { task, final_reply: reply };
  return { state, question: { instructions: TASK_OUTCOME.instructions, options: { ...OUTCOME_OPTIONS } } };
}

/** Ask once and turn the answer into an outcome. Never throws. */
export async function decideTaskOutcome(
  decider: Pick<Decider, "choose">,
  input: TaskOutcomeInput,
  options: { signal?: AbortSignal } = {},
): Promise<TaskOutcome> {
  try {
    if (!input.reply.trim()) return { kind: "fallback", reason: "no_reply" };
    const { state, question } = taskOutcomeRequest(input);
    const result = await decider.choose("taskOutcome", state, question, {
      timeoutMs: TASK_OUTCOME.timeoutMs,
      signal: options.signal,
    });
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    const { choice, pTop } = result.answers;
    if (!(choice in OUTCOME_OPTIONS) || typeof pTop !== "number") return { kind: "fallback", reason: "malformed" };
    if (choice !== "blocked") return { kind: "fallback", reason: "not_blocked" };
    if (pTop < TASK_OUTCOME_MIN_PROBABILITY) return { kind: "fallback", reason: "low_confidence" };
    return { kind: "blocked", probability: pTop };
  } catch {
    return { kind: "fallback", reason: "malformed" };
  }
}
