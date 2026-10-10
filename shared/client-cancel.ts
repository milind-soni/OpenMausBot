// A turn the person stopped, or a client abort, is not a failure. Some
// providers still finish the turn by saying so in assistant text ("The
// request was cancelled by the client.") or by raising that sentence as
// runtime.error. Both are the whole message or nothing: a real error that
// merely mentions a cancellation stays an error.
import { failedTurnCause } from "./failed-turn.ts";

const STOPPED_PREFIX = "stopped:";

/** Activity name for a stopped turn. The word after the prefix is what a
 * phone that prints tool names shows; the desktop localizes it. */
export const STOPPED_TURN_NAME = `${STOPPED_PREFIX} Stopped`;

export function isStoppedTurnName(name: string): boolean {
  return name.startsWith(STOPPED_PREFIX);
}

const HARNESS_PREFIX = /^provider returned a(?: streaming)? completion error:\s*/i;

// Whole message, case-insensitive. Extra words after the sentence do not match.
const CLIENT_CANCEL = [
  /^context\s+canceled\.?$/i,
  /^(?:context\s+canceled)?\s*the\s+request\s+was\s+cancell?ed\s+by\s+the\s+client\.?$/i,
  /^(?:(?:the|this)\s+)?operation\s+was\s+aborted\.?$/i,
  /^(?:the\s+)?request\s+was\s+aborted\.?$/i,
  /^the\s+user\s+aborted\s+a\s+request\.?$/i,
];

/** True when `text` is only a client abort, including the harness wrapper
 * around one (`provider returned a completion error: …`). */
export function isClientCancellation(text: string): boolean {
  const body = text.trim().replace(HARNESS_PREFIX, "").trim();
  if (!body) return false;
  return CLIENT_CANCEL.some((pattern) => pattern.test(body));
}

export type AssistantTranscript =
  | { kind: "text"; text: string }
  | { kind: "stopped" };

export function assistantTranscript(text: string): AssistantTranscript {
  return isClientCancellation(text) ? { kind: "stopped" } : { kind: "text", text };
}

export type ErrorTranscript =
  | { kind: "error"; message: string }
  | { kind: "stopped" };

export function errorTranscript(message: string): ErrorTranscript {
  return isClientCancellation(message) ? { kind: "stopped" } : { kind: "error", message };
}

/** A stored row the chat should read as a stop: the new activity, a legacy
 * assistant bubble that is only the abort sentence, or a legacy error row
 * whose cause is that sentence. A person's own message is never one, and a
 * bubble that also carries files stays a bubble so the files remain. */
export function isCancelledTranscriptRow(message: {
  role: string;
  kind: string;
  text?: string;
  attachments?: readonly unknown[] | null;
  tool?: { name: string } | null;
}): boolean {
  if (message.role === "user") return false;
  if (message.kind === "text") {
    return !message.attachments?.length && isClientCancellation(message.text ?? "");
  }
  if (message.kind === "activity" && message.tool) {
    return isStoppedTurnName(message.tool.name) || isClientCancellation(failedTurnCause(message.tool.name) ?? "");
  }
  return false;
}
