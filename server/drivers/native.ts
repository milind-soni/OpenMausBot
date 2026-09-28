// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// written verbatim next to the canonical stream, so protocol drift can be
// diagnosed by diffing the two.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  const file = join(NATIVE_DIR, `${threadId}.ndjson`);
  try {
    // The session-setup messages carry the credentials the agent is handed —
    // the boat and comms tokens ride inside session/new's mcpServers env, and
    // an MCP header can carry a Composio key. These files are ordinary
    // 0644 files people paste into bug reports, so values are masked while
    // the shape stays intact.
    appendFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(entry.msg) }) + "\n",
      { mode: 0o600 },
    );
    // Best-effort size cap (#1280) — same rule as the write itself: never
    // let logging break the run it is observing.
    capThreadLog(file, currentThreadLogCap());
  } catch {
    /* never let logging break a run */
  }
}
