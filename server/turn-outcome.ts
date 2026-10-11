// What a requester learns when the turn it assigned ends without completing.
// The requester (a Chief of Staff, a lead) decides what happens next: send
// what is left, send it again, or tell the person. So it is told the cause in
// the runtime's own words — the step cap, a stall, a provider reload, a quota,
// an error — what the turn did before it stopped, where the step cap's
// handoff lies, and the turn's last message whole. A bare "error" or "The
// coordinated turn was interrupted" left it guessing, and a guess re-sends the
// whole assignment.
//
// The harness (index.ts) folds runtime events into TurnStops, notes there why
// it stops a turn itself, and reads it when a coordinated or delegated turn
// settles; the wording is a pure function.
import { errorTranscript } from "../shared/client-cancel.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { buildTurnDigest, digestTools } from "./digest.ts";
import type { Message } from "./store.ts";

/** The longest cause an outcome repeats: a provider's HTML body or a stack
 * trace is cut, a sentence a requester acts on is not. */
const REASON_CHARS = 600;

export interface TurnStop {
  turnId?: string;
  /** Why the harness stopped the turn itself (a Company change), noted
   * before it interrupts: the turn's own end may settle it first. */
  cause?: string;
  /** The runtime's last error for the turn, a client abort excepted: its
   * runtime.error, or a provider's own error sent as a reply (a usage limit,
   * an overload: RuntimeEventBase.synthetic). */
  error?: string;
  /** The step cap's handoff: every step the turn ran, in order. */
  handoffPath?: string;
}

/** Each thread's turn as its runtime last described a failure — its error
 * and the handoff a step cap wrote — and the harness's cause when it stopped
 * the turn. A new turn on the thread starts clean, and a read names the turn
 * it settles, so an earlier turn's words never stand in. */
export class TurnStops {
  readonly #byThread = new Map<string, TurnStop>();
  readonly #handoffOwed: (threadId: string) => boolean;

  /** `handoffOwed`: whether the turn on a thread owes its result to a
   * requester, which then picks the work up from the step cap's handoff. A
   * turn nobody awaits is continued from it on its own (turn-continuation.ts),
   * so its account never asks anyone to assign the rest. */
  constructor(options: { handoffOwed?: (threadId: string) => boolean } = {}) {
    this.#handoffOwed = options.handoffOwed ?? (() => true);
  }

  note(event: RuntimeEvent): void {
    if (event.type === "turn.started") {
      this.#byThread.delete(event.threadId);
      return;
    }
    const error = event.type === "runtime.error" ? event.message
      : event.type === "item.completed" && event.itemType === "assistant_text" && event.synthetic ? event.text : undefined;
    if (event.type === "cap.exhausted" ? !this.#handoffOwed(event.threadId)
      : error === undefined || errorTranscript(error).kind !== "error") return;
    const stop = this.#turn(event.threadId, event.turnId);
    if (event.type === "cap.exhausted") stop.handoffPath = event.handoffPath;
    else stop.error = error;
  }

  /** The harness is stopping this turn, for this cause: whichever settles it
   * first, its own end or the harness's teardown, reports the same words. */
  stopping(threadId: string, turnId: string | undefined, cause: string): void {
    this.#turn(threadId, turnId).cause = cause;
  }

  #turn(threadId: string, turnId: string | undefined): TurnStop {
    const held = this.#byThread.get(threadId);
    const stop: TurnStop = held && held.turnId === turnId ? held : { turnId };
    this.#byThread.set(threadId, stop);
    return stop;
  }

  read(threadId: string, turnId?: string): TurnStop | undefined {
    const stop = this.#byThread.get(threadId);
    return stop && (!turnId || !stop.turnId || stop.turnId === turnId) ? stop : undefined;
  }

  /** The thread is gone: nothing reads its last stop again. */
  forget(threadId: string): void {
    this.#byThread.delete(threadId);
  }
}

/** The requester's account of a turn that ended without completing. The
 * cause comes first, since a result chip shows only the start; then what the
 * turn did before it stopped, the handoff, and its last message, unabridged:
 * a report written before a late failure is still the teammate's report. It
 * is quoted, as data: the account reaches prompts the harness speaks in (a
 * delegator's wake), where a teammate's words must never pass for its lines. */
export function stoppedTurnOutcome(input: {
  reason: string;
  /** The thread's messages; only this turn's tool rows are read. */
  activities: readonly Message[];
  turnId?: string;
  said?: string;
  handoffPath?: string;
}): string {
  const parts = [sentence(clip(input.reason, REASON_CHARS))];
  if (input.turnId) {
    const digest = buildTurnDigest({
      turnId: input.turnId, botId: "", threadId: "", at: 0, durationMs: 0,
      activities: input.activities, memory: [], reply: "", hookCoverage: "preview",
    });
    parts.push(digest.toolCalls
      ? `Before it stopped it made ${digest.toolCalls} tool call${digest.toolCalls === 1 ? "" : "s"}: ${digestTools(digest)}.`
      : "No tool calls were seen before it stopped.");
  }
  if (input.handoffPath) parts.push(`Every step it took is listed in ${input.handoffPath}; to finish, assign what is left and point to that file.`);
  const said = input.said?.trim();
  return said ? `${parts.join(" ")}\nIts last message, quoted: ${JSON.stringify(said)}` : parts.join(" ");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sentence(text: string): string {
  const capital = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?…"]$/.test(capital) ? capital : `${capital}.`;
}
