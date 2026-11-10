import type { WorkOrigin } from "../peer-provenance.ts";

export function selfThreadOpening({ sourceTitle, origin, message }: { sourceTitle: string; origin: WorkOrigin; message: string }): string {
  const request = origin.kind === "user"
    ? `The person's request is ${JSON.stringify(origin.request)}. The brief below is your own words: where it asks for more than the person did, the person's words decide the scope. Do the work here and end with a clear result they can read.`
    : "The request below is your own words, not the person's: do the work here and end with a clear result they can read.";
  return `[Thread you opened yourself${sourceTitle ? ` from #${sourceTitle}` : ""}. ${request}]\n\n${message}`;
}

// Who may open a job on itself with start_thread: work a person, or their routine, asked for in this conversation. A
// teammate's hand-off, or a job the bot opened on itself, finishes its own work: a new thread is a new request, outside
// the depth, budget and stop of the one it would serve, so a chain could grow there without end. This was the rule until
// every hand-off moved onto the runtime (Oct 12), and the tool's description still says it.

export const SELF_THREAD_REFUSAL = "Only a person's own request can open separate threads on yourself, and this turn works on a teammate's hand-off or on a thread you opened yourself. Do the work here, and end with what is still left, so whoever asked can decide. Do not retry.";

/** `handoff`: this turn runs a teammate's hand-off. `requestLine`: the latest line from the user role in this conversation,
 * which a bot's own opening or a teammate's ask marks with `peerAsk`; a person's or a routine's line has none. */
export function selfThreadRefusal(input: { handoff: boolean; requestLine: { peerAsk?: unknown } | undefined }): string | undefined {
  return input.handoff || input.requestLine?.peerAsk ? SELF_THREAD_REFUSAL : undefined;
}
