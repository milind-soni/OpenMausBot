// Context rebuilds by bytes, with a compaction record
// (docs/plans/2026-09-14-phase-0-foundation.md, item 0.7).
//
// When the harness has to rebuild a thread's context itself — a rewind, an
// engine switch, an update appended outside the provider's session, a
// rejected resume, and every single turn on the transcript-replay engines —
// it used to send "the last 40 text messages". Messages are the wrong unit:
// forty one-liners is nothing, forty pasted logs is a context window. This
// selects by BYTES, newest first, and it honours a compaction record: the
// summary stands in for everything before its first kept message, so the
// rebuild carries the gist of the old history at a fraction of its size.
// Pure; the fold and the room serializer feed it rendered entries.

export interface ReplayEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface CompactionRecord {
  /** The message the summary stops before; everything from it on is kept. */
  firstKeptId: string;
  summary: string;
}

export interface ReplaySelection {
  /** Entries to replay, oldest first, all at or after the compaction point. */
  transcript: ReplayEntry[];
  /** The compaction summary, when a record applied. */
  summary?: string;
  /** Messages the compaction summary stands in for. */
  compacted: number;
  /** Messages after the compaction point that did not fit the budget. */
  dropped: number;
  /** The lines to send BEFORE the transcript: summary, then drop notice. */
  lead: Array<{ role: "assistant"; text: string }>;
}

export const DEFAULT_REBUILD_BYTES = 24_000;

export function selectReplay(
  history: readonly ReplayEntry[],
  opts: { budgetBytes: number; compaction?: CompactionRecord },
): ReplaySelection {
  let entries = [...history];
  let summary: string | undefined;
  let compacted = 0;
  if (opts.compaction) {
    const at = entries.findIndex((e) => e.id === opts.compaction!.firstKeptId);
    if (at >= 0) {
      compacted = at;
      entries = entries.slice(at);
      summary = opts.compaction.summary;
    }
  }
  const kept: ReplayEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(entries[i]!.text, "utf8") + 16;
    if (kept.length > 0 && used + size > opts.budgetBytes) break;
    kept.unshift(entries[i]!);
    used += size;
  }
  const dropped = entries.length - kept.length;
  const lead: ReplaySelection["lead"] = [];
  if (summary) lead.push({ role: "assistant", text: `[Summary of the conversation before this point: ${summary}]` });
  if (dropped > 0) lead.push({ role: "assistant", text: `[${dropped} earlier message${dropped === 1 ? " is" : "s are"} not shown]` });
  return { transcript: kept, ...(summary ? { summary } : {}), compacted, dropped, lead };
}
