import { timingSafeEqual } from "node:crypto";

/** How long after its turn ends a background `PostToolUse` may still save that turn's full tool output. */
export const LATE_TOOL_RESULT_MS = 60_000;

export interface EndedHookTurn {
  threadId: string;
  botId: string;
  turnId: string;
  /** The turn's hooks bearer. */
  token: string;
  /** Tool calls of the turn whose full output was not saved when it ended; each may be claimed once. */
  toolUseIds: ReadonlySet<string>;
}

/** Security invariant: an ended turn's hooks bearer is honoured for nothing but saving the full output of that turn's own
 * tool calls, each once, until LATE_TOOL_RESULT_MS after the turn ended; revoking the thread's bearers ends it at once. */
export function createLateToolResults(now: () => number = Date.now) {
  const ended: Array<Omit<EndedHookTurn, "toolUseIds"> & { toolUseIds: Set<string>; until: number }> = [];
  const live = () => {
    const at = now();
    for (let i = ended.length - 1; i >= 0; i--) if (ended[i]!.until <= at || ended[i]!.toolUseIds.size === 0) ended.splice(i, 1);
    return ended;
  };
  return {
    turnEnded(turn: EndedHookTurn): void {
      if (turn.toolUseIds.size) ended.push({ ...turn, toolUseIds: new Set(turn.toolUseIds), until: now() + LATE_TOOL_RESULT_MS });
    },
    /** The bot and conversation an ended turn's bearer belongs to, compared in constant time. */
    holder(header: string | string[] | undefined): { botId: string; threadId: string } | null {
      const got = Buffer.from(Array.isArray(header) ? "" : (header ?? ""));
      for (const turn of live()) {
        const expected = Buffer.from(`Bearer ${turn.token}`);
        if (got.length === expected.length && timingSafeEqual(got, expected)) return { botId: turn.botId, threadId: turn.threadId };
      }
      return null;
    },
    /** The ended turn a tool call of this conversation belongs to, if its output may still be saved; claims it. */
    claim(threadId: string, botId: string, toolUseId: string): string | null {
      const turn = live().find((candidate) => candidate.threadId === threadId && candidate.botId === botId && candidate.toolUseIds.has(toolUseId));
      if (!turn) return null;
      turn.toolUseIds.delete(toolUseId);
      return turn.turnId;
    },
    forgetThread(threadId: string): void {
      for (let i = ended.length - 1; i >= 0; i--) if (ended[i]!.threadId === threadId) ended.splice(i, 1);
    },
    clear(): void {
      ended.length = 0;
    },
  };
}
