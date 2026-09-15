// Goal recitation on long threads (Phase 1 part 4, item 1; Manus's "recite
// the goal"). A conversation's first request and any standing rule in it
// drift to the far end of the context as the thread grows, and after a
// compaction they survive only inside the summary. The harness therefore
// restates, in the turn text and with no model call, where the conversation
// began and what the last step was — on the first turn after a compaction
// and every tenth turn past the tenth. Every engine reads turn text: full.
import { digestPromptLine } from "./digest.ts";
import type { Message } from "./store.ts";

export const RECITE_EVERY = 10;
const GOAL_CHARS = 300;
const STEP_CHARS = 200;

export interface ProgressInput {
  /** The thread's active path, WITHOUT the message that starts this turn. */
  messages: readonly Message[];
  botName: string;
  /** True when this turn follows a harness compaction (fresh session). */
  afterCompaction: boolean;
}

const clip = (text: string, max: number) => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

/** How many turns the person has taken so far (user text messages). */
export function turnIndex(messages: readonly Message[]): number {
  return messages.filter((m) => m.role === "user" && m.kind === "text" && m.text).length;
}

/** Whether this turn recites: right after a compaction, or on every tenth
 * turn once the thread is ten turns long (the turn about to run is index+1). */
export function shouldRecite(input: ProgressInput): boolean {
  if (input.afterCompaction) return true;
  const next = turnIndex(input.messages) + 1;
  return next >= RECITE_EVERY && next % RECITE_EVERY === 0;
}

/** The note, or null when there is nothing to recite (no earlier request). */
export function progressNote(input: ProgressInput): string | null {
  if (!shouldRecite(input)) return null;
  const first = input.messages.find((m) => m.role === "user" && m.kind === "text" && m.text);
  if (!first?.text) return null;
  let lastStep: string | null = null;
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const m = input.messages[i]!;
    if (m.kind === "digest" && m.digest) { lastStep = digestPromptLine(m.digest, input.botName); break; }
    if (m.role === "bot" && m.kind === "text" && m.text) { lastStep = `you replied: ${m.text}`; break; }
  }
  return [
    "[Where this conversation stands, kept by OpenMausBot:",
    `- It began with this request: "${clip(first.text, GOAL_CHARS)}". Any standing instruction in it still applies.`,
    ...(lastStep ? [`- Last step: ${clip(lastStep, STEP_CHARS)}`] : []),
    "]",
  ].join("\n");
}
