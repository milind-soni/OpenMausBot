// Pure helpers the handler modules receive through ToolContext: JSON
// record checks, ordinal labels for queue positions, proposal/confirmation
// result shaping, and recall attribution. agents-proxy.ts imports these
// once and wires them into toolContext; PROPOSAL_OUTCOME is the shared
// suffix for every propose_* description in the tool table.
import type { Json } from "./context.ts";

/** "1st", "2nd", "3rd", "4th" — the queue position as a person says it. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
}

export function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Full Access is decided by the harness, not inferred from a model claim or
 * local environment flag. Missing state preserves older pending responses. */
export function completedProposalResult(r: Json, subject: string): { text: string; isError?: boolean } | undefined {
  const state = r.state;
  const result = jsonRecord(r.result) ? r.result : undefined;
  const error = typeof r.error === "string" ? r.error : typeof result?.error === "string" ? result.error : undefined;
  const attention = error ?? (r.settlementPending && typeof r.message === "string" ? r.message : undefined);
  if ((!state || state === "pending") && !error) return undefined;
  const summary = typeof r.summary === "string" && r.summary.trim() ? `\n\n${r.summary.trim()}` : "";
  const details = result ? `\n\nResult: ${JSON.stringify(result)}` : "";
  if (state !== "applied" || (result?.state !== undefined && result.state !== "applied")) {
    return { text: `The request for ${subject} did not complete successfully.${error ? ` ${error}` : ""}${summary}${details}\n\nDo not claim it was applied. Address the reported blocker rather than repeating the request or asking for a duplicate confirmation.`, isError: true };
  }
  return { text: `Applied ${subject}.${summary}${details}${attention ? `\n\nNeeds attention: ${attention}` : ""}\n\nNo additional confirmation is needed. Continue the requested work; do not wait for a review card or ask the user to approve this change again.` };
}

export function confirmationResult(r: Json, fallback: string, noun = "routine"): { text: string; isError?: boolean } {
  const completed = completedProposalResult(r, fallback);
  if (completed) return completed;
  const summary = typeof r.summary === "string" && r.summary.trim() ? `\n\n${r.summary.trim()}` : "";
  return {
    text: `A confirmation card is now visible to the user for ${fallback}.${summary}\n\nThis change has not been applied yet. End this turn and wait for the user to confirm or deny the card; do not claim the ${noun} was created or changed before confirmation.`,
  };
}

/** Who said a recalled line, as the header of a hit or a read. A user-role
 * line another bot delivered with ask_bot is labelled as that bot's: the
 * snippet windows past the provenance note in the text, and a peer's ask
 * recalled as the user's request is the misattribution the note exists to
 * prevent. */
export function recallSpeaker(hit: Json): string {
  if (typeof hit.peer === "string" && hit.peer) return `@${hit.peer} (another bot, via ask_bot — not your user)`;
  if (typeof hit.from === "string" && hit.from) return hit.from;
  return hit.role === "user" ? "user" : "you";
}

// Suffix appended to the description of every propose_* tool table entry.
export const PROPOSAL_OUTCOME = " Read the result: granted Full Access may apply the change immediately. If applied, continue the requested work without another confirmation. Only a pending result requires ending the turn and waiting for the in-app decision. Never claim success from the permission mode alone; report failed or cancelled results honestly. This does not elevate another bot's execution permissions.";
