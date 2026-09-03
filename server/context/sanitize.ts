// Bounding what a tool call leaves behind.
//
// A tool observation is durable and portable: it is written to SQLite, and
// it is replayed to whatever engine the bot is switched to later. So it
// passes through here first — caps, control-strip, and the existing secret
// boundary — and raw provider output is never promoted straight into it.
import { redactSecretsInText } from "../redact.ts";
import type { ToolContextSnapshot } from "./types.ts";

/** Caps chosen so a single call cannot dominate a small model's window: the
 * output cap is roughly 2k tokens, the input cap roughly 700. */
export const TOOL_INPUT_LIMIT = 2_000;
export const TOOL_OUTPUT_LIMIT = 6_000;
export const PATH_LIMIT = 512;
export const PATH_LIST_LIMIT = 50;
export const TOOL_NAME_LIMIT = 200;

/** C0/C1 controls except tab and newline. Terminal escapes in tool output
 * would otherwise be replayed into a prompt and, on the way, into any log or
 * terminal that renders the transcript. */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const stripControls = (value: string) => value.replace(CONTROLS, "");

interface Clipped {
  value: string;
  clipped: boolean;
}

/** Redact, strip, then cap — in that order. Capping first would let a secret
 * survive by being cut in half; redacting after stripping would miss a
 * credential that had a control character inside it. */
function bound(value: string, limit: number): Clipped {
  const clean = stripControls(redactSecretsInText(value)).trim();
  if (clean.length <= limit) return { value: clean, clipped: false };
  return { value: `${clean.slice(0, limit - 1).trimEnd()}\u2026`, clipped: true };
}

function boundPaths(paths: readonly string[] | undefined): { value: string[]; clipped: boolean } | undefined {
  if (!paths?.length) return undefined;
  const kept = paths.slice(0, PATH_LIST_LIMIT);
  let clipped = kept.length < paths.length;
  const value: string[] = [];
  for (const path of kept) {
    const one = bound(path, PATH_LIMIT);
    if (!one.value) continue;
    clipped ||= one.clipped;
    value.push(one.value);
  }
  return value.length ? { value, clipped } : undefined;
}

export interface RawToolObservation {
  callId?: string;
  name: string;
  input?: string;
  output?: string;
  ok?: boolean;
  filesRead?: readonly string[];
  filesModified?: readonly string[];
}

/** Turn one raw tool call into the bounded record that gets persisted.
 *
 * Idempotent: feeding a snapshot back through produces the same snapshot, so
 * a payload that crosses this boundary twice — a content scrub plus the
 * store-wide scrub — does not drift, and `clipped` does not flip on a second
 * pass over already-clipped text. */
export function sanitizeToolObservation(raw: RawToolObservation): ToolContextSnapshot {
  const name = bound(raw.name, TOOL_NAME_LIMIT);
  const input = raw.input ? bound(raw.input, TOOL_INPUT_LIMIT) : undefined;
  const output = raw.output ? bound(raw.output, TOOL_OUTPUT_LIMIT) : undefined;
  const read = boundPaths(raw.filesRead);
  const modified = boundPaths(raw.filesModified);

  const clipped =
    name.clipped ||
    Boolean(input?.clipped) ||
    Boolean(output?.clipped) ||
    Boolean(read?.clipped) ||
    Boolean(modified?.clipped);

  return {
    ...(raw.callId ? { callId: bound(raw.callId, TOOL_NAME_LIMIT).value } : {}),
    // a nameless tool is still worth recording as history; the projector
    // renders it as an unnamed action rather than dropping the turn
    name: name.value || "tool",
    ...(input?.value ? { inputSummary: input.value } : {}),
    ...(output?.value ? { outputSummary: output.value } : {}),
    ...(raw.ok === undefined ? {} : { ok: raw.ok }),
    ...(read ? { filesRead: read.value } : {}),
    ...(modified ? { filesModified: modified.value } : {}),
    ...(clipped ? { clipped: true } : {}),
  };
}
