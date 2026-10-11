// What the conversation that handed work to a teammate is told while that
// teammate waits on the person, and after. Every line says what happened to
// the request (approved, denied, nobody answered, closed), never "got your
// approval" for an action nobody approved. The engines' own prompts stay the
// only gates: nothing here answers, holds or grants anything.
import type { RuntimeEvent } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";

type Resolved = Extract<RuntimeEvent, { type: "request.resolved" }>;

/** The "Waiting on your approval in @X" chip once its card settles, by who
 * settled it. `ok` is false whenever the asked-about action did not run. */
export function settledWaitingChip(name: string, kind: string, behavior: Resolved["behavior"], source: Resolved["source"]): { name: string; ok: boolean } {
  const who = `@${name}`;
  const question = kind === "answer";
  // A timeout or a closed turn says so even when the engine filed it as an
  // "answer" (Claude's own note for an unanswered or abandoned question).
  if (source === "timeout") return question
    ? { name: `Nobody answered ${who}'s question in time`, ok: false }
    : { name: `Nobody answered ${who}'s approval in time — that step did not run`, ok: false };
  if (source === "system" || source === "unavailable") return question
    ? { name: `${who}'s question closed before anyone answered`, ok: false }
    : { name: `${who}'s approval closed before anyone answered — that step did not run`, ok: false };
  if (behavior === "deny") return { name: question ? `${who}'s question was dismissed` : `${who}'s request was denied`, ok: false };
  return source === "user"
    ? { name: `${who} got your ${question ? "answer" : "approval"}`, ok: true }
    : { name: question ? `${who}'s question was answered` : `${who}'s request was approved`, ok: true };
}

/** Why handed-out work has not started: its teammate's free slots are held,
 * and one of them by a card waiting on the person in `title`. */
export function queuedBehindPersonText(name: string, kind: "approval" | "question" | "review", title: string): string {
  return `Queued for @${name}, who's waiting on your ${kind === "question" ? "answer" : kind} in “${title}”`;
}

const MAX_ACTIONS = 10;
const MAX_THREADS = 256;

/** Approvals nobody answered, by thread, for the turn that asked them. Every
 * engine denies such a request on its own timer and the turn carries on, so
 * its result can read as done while those actions never ran. Whoever reports
 * that turn's result to the one awaiting it (a Chief, a delegating bot, a
 * room) puts the note on it. A later turn of the thread starts a new list;
 * a reader of another turn never sees this one's. In memory only. */
export class UnansweredApprovals {
  private readonly byThread = new Map<string, { turnId: string; actions: string[] }>();

  /** One approval card of `turnId` closed on its timer. `tool` and `summary`
   * are the card's; the stored line is redacted and kept to one short line.
   * A card no turn owns has no result to carry it. */
  record(threadId: string, turnId: string | undefined, tool: string | undefined, summary: string | undefined): void {
    if (!turnId) return;
    const noted = this.byThread.get(threadId);
    const actions = noted?.turnId === turnId ? noted.actions : [];
    const action = redactSecretsInText(tool && summary && !summary.includes(tool) ? `${tool}: ${summary}` : summary || tool || "an action")
      .replace(/\s+/g, " ").trim().slice(0, 160);
    if (!actions.includes(action) && actions.length < MAX_ACTIONS) actions.push(action);
    this.byThread.delete(threadId);
    this.byThread.set(threadId, { turnId, actions });
    if (this.byThread.size > MAX_THREADS) this.byThread.delete(this.byThread.keys().next().value!);
  }

  /** The turn's result as its requester reads it. A finished turn leads with
   * the note, so no cap on the result can cut it off; a failed one keeps its
   * reason first, where a chip shows it. Unchanged when every approval was
   * answered. */
  annotate(threadId: string, turnId: string | undefined, text: string, ok: boolean): string {
    const noted = this.byThread.get(threadId);
    if (!noted || noted.turnId !== turnId) return text;
    const one = noted.actions.length === 1;
    const note = `[OpenMausBot: nobody answered the ${one ? "approval" : "approvals"} for ${noted.actions.map(action => `“${action}”`).join(", ")} in time, so ${one ? "it" : "they"} did not run. Do not report ${one ? "it" : "them"} as done; ${one ? "it needs" : "they need"} the person's approval.]`;
    if (!text) return note;
    return ok ? `${note}\n\n${text}` : `${text}\n\n${note}`;
  }
}
