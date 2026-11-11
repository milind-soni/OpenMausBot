// A local model that is stuck says so by repeating itself: the same call, the same answer, until the round limit. Counted
// per call rather than back to back, so taking turns between two stuck calls is still stuck. A different answer starts the
// count over, because that is progress. Each round on a laptop costs tens of seconds, so this stops long before the limit.
import { createHash } from "node:crypto";

const REFUSE_AFTER_FAILURES = 3;
const REFUSALS_BEFORE_STOP = 2;
const SAME_ANSWER_NOTE_AT = 3;
const SAME_ANSWER_STOP_AT = 10;

interface Seen {
  ok: boolean;
  answer: string;
  streak: number;
}

/** The same arguments in another key order are the same call. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
}

function callKey(name: string, args: string): string {
  try { return `${name}:${JSON.stringify(canonical(JSON.parse(args)))}`; } catch { return `${name}:${args}`; }
}

const digest = (text: string) => createHash("sha256").update(text).digest("base64");

export class ChatRepeatGuard {
  private readonly seen = new Map<string, Seen>();
  private refusals = 0;
  private stuck: string | null = null;

  /** Why this call must not run again, or null. Asked before it runs. */
  refuses(name: string, args: string): string | null {
    const seen = this.seen.get(callKey(name, args));
    if (!seen || seen.ok || seen.streak < REFUSE_AFTER_FAILURES) return null;
    if (++this.refusals >= REFUSALS_BEFORE_STOP) {
      this.stuck = `The model kept repeating a call to ${name} that had already failed ${seen.streak} times the same way, so the turn was stopped. Try again with a clearer request, or choose a stronger model.`;
    }
    return `[OpenMausBot: this exact call was not run. It already failed ${seen.streak} times the same way. Use different inputs, try another approach, or say what is blocking.]`;
  }

  /** A result the model has seen before, with a note to add to it. A screenshot is never the same answer: its text says
   * little, and the picture is what changed. */
  noteAfter(name: string, args: string, result: { ok: boolean; text: string; images?: readonly unknown[] }): string | undefined {
    const key = callKey(name, args);
    if (result.images?.length) {
      this.seen.delete(key);
      return undefined;
    }
    const answer = digest(result.text);
    const before = this.seen.get(key);
    const streak = before && before.ok === result.ok && before.answer === answer ? before.streak + 1 : 1;
    this.seen.set(key, { ok: result.ok, answer, streak });
    if (!result.ok) {
      return streak === REFUSE_AFTER_FAILURES ? `[OpenMausBot: this exact call has now failed ${streak} times the same way, so it will not run again this turn. Change approach, or say what is blocking.]` : undefined;
    }
    if (streak >= SAME_ANSWER_STOP_AT) {
      this.stuck = `The model made the same call to ${name} ${streak} times and got the same answer each time, so the turn was stopped. Try again with a clearer request, or choose a stronger model.`;
    }
    return streak >= SAME_ANSWER_NOTE_AT ? `[OpenMausBot: this call has returned this same result ${streak} times. If that was expected, carry on. Otherwise use the result, try something else, or give your answer.]` : undefined;
  }

  /** Set once the turn should end: the words to end it with. */
  get stopped(): string | null {
    return this.stuck;
  }
}
