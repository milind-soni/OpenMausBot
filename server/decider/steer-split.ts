// Correction or new request: a message sent while a bot is busy used to be
// steered into the running turn or merged into its follow-up, even an
// unrelated "also book me a cab".
//
// One Choice (STEER_SPLIT in jobs.ts: same / separate) over what the running
// turn was asked and the new message. Acting on it: "separate" at p >= 0.8
// is not steered; it waits in the thread's queue as its own item, which
// never merges with the messages around it, and runs as its own follow-up
// turn once the current one finishes. Anything else, and any failure at
// all, keeps today's steer-or-queue. Nothing here throws.
//
// The person is waiting on the send, so the budget is 800 ms, and sends to
// one thread are decided one at a time (steerSplitLane) so a slow answer
// never lets a later message overtake an earlier one.
import type { Decider } from "./index.ts";
import { RELAY_MAX_STATE_BYTES } from "./relay.ts";
import { STEER_SPLIT } from "./jobs.ts";
import type { DeciderFailure } from "./types.ts";

/** Splitting a correction off its task is worse than merging an unrelated
 * request (the bot would act on a half-instruction), so only a clear
 * "separate" acts. */
export const STEER_SPLIT_MIN_PROBABILITY = 0.8;

const TITLE_MAX = 120;
const RUNNING_TASK_MAX = 1_500;
const MESSAGE_MAX = 2_000;

type SplitChoice = "same" | "separate";
/** The contract's fixed options, verbatim: the relay checks them exactly. */
const SPLIT_OPTIONS = STEER_SPLIT.options as Readonly<Record<SplitChoice, string>>;

export interface SteerSplitInput {
  /** The thread's title, when it has a real one. */
  title?: string;
  /** The person's message that started the running turn. */
  request?: string;
  /** The message just sent. */
  message: string;
}

export type SteerSplit =
  | { kind: "separate"; probability: number }
  | { kind: "fallback"; reason: DeciderFailure | "low_confidence" | "same" | "no_task" };

const flat = (value: string) => value.replace(/\s+/g, " ").trim();

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function steerSplitRequest(input: SteerSplitInput) {
  const title = clip(flat(input.title ?? ""), TITLE_MAX);
  const request = flat(input.request ?? "");
  const runningTask = clip([title, request].filter(Boolean).join(": "), RUNNING_TASK_MAX);
  let message = clip(flat(input.message), MESSAGE_MAX);
  // Characters bound ordinary text; this bounds wide characters in bytes, so
  // Cloud Pro's relay still takes the request.
  while (message.length > 1 && Buffer.byteLength(JSON.stringify({ running_task: runningTask, new_message: message })) > RELAY_MAX_STATE_BYTES) {
    message = clip(message, Math.floor(message.length / 2));
  }
  const state = { running_task: runningTask, new_message: message };
  return { state, question: { instructions: STEER_SPLIT.instructions, options: { ...SPLIT_OPTIONS } } };
}

/** Ask once and turn the answer into a split. Never throws. */
export async function decideSteerSplit(
  decider: Pick<Decider, "choose">,
  input: SteerSplitInput,
  options: { signal?: AbortSignal } = {},
): Promise<SteerSplit> {
  try {
    const { state, question } = steerSplitRequest(input);
    if (!state.running_task || !state.new_message) return { kind: "fallback", reason: "no_task" };
    const result = await decider.choose("steerSplit", state, question, {
      timeoutMs: STEER_SPLIT.timeoutMs,
      signal: options.signal,
    });
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    const { choice, pTop } = result.answers;
    if (!(choice in SPLIT_OPTIONS) || typeof pTop !== "number") return { kind: "fallback", reason: "malformed" };
    if (choice !== "separate") return { kind: "fallback", reason: "same" };
    if (pTop < STEER_SPLIT_MIN_PROBABILITY) return { kind: "fallback", reason: "low_confidence" };
    return { kind: "separate", probability: pTop };
  } catch {
    return { kind: "fallback", reason: "malformed" };
  }
}

/** One send at a time per thread while a split is being decided, so the
 * person's messages keep their order through the wait. */
export class SteerSplitLane {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** A send is already waiting here: a later one to the same thread must
   * queue behind it even if the thread has gone idle meanwhile. */
  pending(key: string): boolean {
    return this.tails.has(key);
  }

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
