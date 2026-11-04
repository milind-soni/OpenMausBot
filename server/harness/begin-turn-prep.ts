/**
 * Pure turn-context prep shared by beginTurn. Keeps selectReplay wiring out of index.ts.
 */
import {
  DEFAULT_REBUILD_BYTES,
  latestCompaction,
  replayToolCalls,
  selectReplay,
  type CompactionRecord,
  type ReplayEntry,
} from "../context-rebuild.ts";
import type { Message } from "../store.ts";

export interface TurnReplayPrep {
  selection: ReturnType<typeof selectReplay>;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  contextReset: boolean;
  compaction: (CompactionRecord & { id: string }) | undefined;
}

/** Mark coordination request/result chips so they are not replayed as ordinary chat. */
export function coordinationSkipIds(
  activeMessages: readonly Message[],
  coordination: { id: string; resumed?: boolean } | undefined,
  childIds: ReadonlySet<string> | undefined,
): Set<string> {
  const skip = new Set<string>();
  if (!coordination) return skip;
  for (const m of activeMessages) {
    if (!m.roomRequest) continue;
    if (
      (m.roomRequest.phase === "request" && m.roomRequest.id === coordination.id) ||
      (m.roomRequest.phase === "result" && childIds?.has(m.roomRequest.id))
    ) {
      skip.add(m.id);
    }
  }
  return skip;
}

export function prepareTurnReplay(input: {
  context: ReplayEntry[];
  activeMessages: readonly Message[];
  skipTranscript: ReadonlySet<string>;
  rebuildBytes?: number;
  appliedCompactionId?: string;
  compaction?: (CompactionRecord & { id: string }) | undefined;
  contextSettings?: Parameters<typeof replayToolCalls>[1];
}): TurnReplayPrep {
  const record = input.compaction ?? latestCompaction(input.activeMessages);
  const selection = selectReplay(input.context, {
    budgetBytes: input.rebuildBytes ?? DEFAULT_REBUILD_BYTES,
    excludedIds: input.skipTranscript,
    compaction: record,
    tools: replayToolCalls(input.activeMessages, input.contextSettings),
  });
  return {
    selection,
    transcript: selection.transcript.map(({ role, text }) => ({ role, text })),
    contextReset: selection.compacted > 0 && record?.id !== input.appliedCompactionId,
    compaction: record,
  };
}

export { DEFAULT_REBUILD_BYTES, latestCompaction };
