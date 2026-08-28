// Bounding what a harness-owned MCP server hands back to an agent.
//
// CLI drivers run their own tools, so the harness never sees that output —
// this only covers the servers WE own (computer-proxy, agents-proxy,
// phone-proxy), which is where the bloat actually is: semantic browser
// snapshots, computer_exec stdout, ask_bot replies. A 400 KB tool result is
// not information, it is a context window spent, and the agent cannot
// un-spend it.
//
// The head is always kept: the beginning of an output is where the answer
// usually is, and a caller that loses it has to run the tool again.
//
// A bot with a private workspace can read a spilled file with its ordinary
// file tools, so the remainder is written there and named. A bot without one
// only gets told what was dropped — still the whole point, which is that the
// context window survives the call.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { workspaceDir } from "./workspace.ts";

export const SPILL_THRESHOLD_BYTES = 20_000;
export const SPILL_HEAD_BYTES = 2_000;
export const MAX_SPILL_FILE_BYTES = 1_000_000;

function headSlice(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= SPILL_HEAD_BYTES) return text;
  // a multi-byte character sliced in half decodes as U+FFFD — drop it
  return buf.subarray(0, SPILL_HEAD_BYTES).toString("utf8").replace(/�+$/, "");
}

export function spillDir(botId: string): string {
  return join(workspaceDir(botId), ".maus", "tool-output");
}

/** Write the whole output somewhere the bot can read it back. Returns the
 * path, or null when it could not be written — a failed spill must never
 * fail the tool call it was only trying to make smaller. */
function spill(botId: string, text: string): string | null {
  try {
    const dir = spillDir(botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${randomUUID()}.txt`);
    const buf = Buffer.from(text, "utf8");
    const capped = buf.byteLength > MAX_SPILL_FILE_BYTES ? buf.subarray(0, MAX_SPILL_FILE_BYTES) : buf;
    // tool output is whatever the agent was looking at — treat it as private
    writeFileSync(path, capped, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

export function boundToolText(text: string, opts?: { botId?: string; label?: string }): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= SPILL_THRESHOLD_BYTES) return text;
  const head = headSlice(text);
  const shown = Buffer.byteLength(head, "utf8");
  const path = opts?.botId ? spill(opts.botId, text) : null;
  const what = opts?.label ? `${opts.label} output` : "Output";
  if (path) {
    return `${head}\n\n[${what} truncated: ${total} bytes total, first ${shown} shown. The full output is on disk at ${path} — read it with your file tools, or narrow the command instead.]`;
  }
  return `${head}\n\n[${what} truncated: ${total} bytes total, first ${shown} shown. Re-run narrowed (grep/head/a tighter selector) if you need the rest.]`;
}
