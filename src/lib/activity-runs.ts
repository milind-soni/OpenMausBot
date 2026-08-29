// Grouping a transcript's tool chips into runs.
//
// A bot working through a task emits one chip per tool call, and a long
// stretch of them buries the thing you actually came to read: what the bot
// SAID. Consecutive finished steps fold into a single row that names them;
// text between two stretches breaks the run, so the bot's words always
// separate one run from the next.
import type { Message } from "@/state/store";

export type TranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

/** A step that may be folded away: finished, a real tool, and not a
 * bot⇄bot chip (those are navigation, not work) or a failed turn (that
 * renders as an error). A step still running stays out, so live progress
 * is never hidden behind a fold. */
function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm) return false;
  if (tool.ok === undefined) return false;
  return !tool.name.startsWith("error:");
}

/** Runtime loop heuristics are useful for diagnostics, but they are not a
 * completed tool, a real failure, or an action the user can take. Older
 * builds persisted them as failed activity chips; keep those rows out of
 * the conversation and its folded step summaries. */
export function isInternalActivityDiagnostic(message: Message): boolean {
  return (
    message.kind === "activity" &&
    message.tool?.name.startsWith("Same call repeated ") === true
  );
}

export function groupActivityRuns(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    // one step on its own is cheaper to read than a fold that hides it
    if (run.length > 1) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    if (isInternalActivityDiagnostic(message)) continue;
    if (foldable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          new Date(first.at).toDateString() !== new Date(message.at).toDateString())
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

/** The one line a folded run has to earn its place with: how much work it
 * completed and whether anything needs inspection. Raw commands belong in
 * the expanded detail, not in a transcript-width summary. */
export function describeRun(messages: Message[]): string {
  const failed = messages.filter((message) => message.tool?.ok === false).length;
  const completed = messages.filter((message) => message.tool?.ok === true).length;
  const running = messages.length - completed - failed;
  if (failed > 0) return `${messages.length} actions · ${completed} completed · ${failed} failed`;
  if (running > 0) return `${messages.length} actions · ${completed} completed · ${running} running`;
  return `${messages.length} actions completed`;
}
