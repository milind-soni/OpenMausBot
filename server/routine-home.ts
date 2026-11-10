// Where a routine lives on a Team Cloud (docs/team-cloud.md "Routines"). One that names someone's private chat, the chat
// it was made in or the one it reports into, is that person's alone, as the chat is; any other routine is its place's
// (the bot's, or its group chat's). The chat a routine opened for its own results is not a place the person chose, so
// it does not make the routine theirs.
import { isOwnResultsChat } from "./automation-destinations.ts";
import type { TaskRecord } from "./store.ts";

export interface RoutinePlace {
  botId?: unknown;
  name?: unknown;
  sourceThreadId?: unknown;
  resultsThreadId?: unknown;
}

export interface RoutineHomeDeps {
  /** The person a conversation is private to, else null (audience.ts). */
  privateTo(threadId: string): string | null;
  task(botId: string, threadId: string): Pick<TaskRecord, "title" | "askedAt"> | null | undefined;
}

const id = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The person whose private chat the routine lives in; null for one of a shared place, and anywhere off a team. */
export function routineHome(routine: RoutinePlace, deps: RoutineHomeDeps): string | null {
  const source = id(routine.sourceThreadId);
  const made = source ? deps.privateTo(source) : null;
  if (made) return made;
  const results = id(routine.resultsThreadId);
  if (!results) return null;
  const task = typeof routine.botId === "string" ? deps.task(routine.botId, results) : null;
  if (task && isOwnResultsChat(typeof routine.name === "string" ? routine.name : "", task)) return null;
  return deps.privateTo(results);
}
