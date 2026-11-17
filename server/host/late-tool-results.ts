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
  const presents = (header: string | string[] | undefined, token: string) => {
    const got = Buffer.from(Array.isArray(header) ? "" : (header ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  return {
    turnEnded(turn: EndedHookTurn): void {
      if (turn.toolUseIds.size) ended.push({ ...turn, toolUseIds: new Set(turn.toolUseIds), until: now() + LATE_TOOL_RESULT_MS });
    },
    /** The bot and conversation an ended turn's bearer belongs to. */
    holder(header: string | string[] | undefined): { botId: string; threadId: string } | null {
      const turn = live().find((candidate) => presents(header, candidate.token));
      return turn ? { botId: turn.botId, threadId: turn.threadId } : null;
    },
    /** The ended turn whose bearer this is, if that turn's tool call still waits for its full output. */
    turnFor(header: string | string[] | undefined, threadId: string, botId: string, toolUseId: string): string | null {
      return live().find((turn) => turn.threadId === threadId && turn.botId === botId && turn.toolUseIds.has(toolUseId) && presents(header, turn.token))?.turnId ?? null;
    },
    saved(threadId: string, turnId: string, toolUseId: string): void {
      for (const turn of ended) if (turn.threadId === threadId && turn.turnId === turnId) turn.toolUseIds.delete(toolUseId);
    },
    forgetThread(threadId: string): void {
      for (let i = ended.length - 1; i >= 0; i--) if (ended[i]!.threadId === threadId) ended.splice(i, 1);
    },
    clear(): void {
      ended.length = 0;
    },
  };
}
