import { timingSafeEqual } from "node:crypto";

/** How long after its turn ends a background `PostToolUse` may still save that turn's full tool output. */
export const LATE_TOOL_RESULT_MS = 60_000;
const REVOKED_KEPT = 64;

export interface EndedHookTurn {
  threadId: string;
  botId: string;
  turnId: string;
  /** The turn's hooks bearer. */
  token: string;
  /** Tool calls of the turn whose full output was not saved when it ended; each may be claimed once. */
  toolUseIds: ReadonlySet<string>;
}

/** A conversation row, as far as remembering a turn's unsaved tool calls needs it. */
interface ToolRow {
  kind: string;
  turnId?: string;
  tool?: { itemId?: string; fullResult?: unknown };
}

/** Security invariant: an ended turn's hooks bearer is honoured for nothing but saving the full output of that turn's own
 * tool calls, each once, until LATE_TOOL_RESULT_MS after the turn ended; revoking the thread's bearers ends it at once. */
export function createLateToolResults(now: () => number = Date.now) {
  const ended: Array<Omit<EndedHookTurn, "toolUseIds"> & { toolUseIds: Set<string>; until: number }> = [];
  const revoked = new Map<string, { threadId: string; botId: string; token: string }>();
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
  const turnEnded = (turn: EndedHookTurn): void => {
    live();
    if (turn.toolUseIds.size) ended.push({ ...turn, toolUseIds: new Set(turn.toolUseIds), until: now() + LATE_TOOL_RESULT_MS });
  };
  return {
    /** Ended turns held, closed windows included until the next prune. */
    get held(): number {
      return ended.length;
    },
    /** A turn can complete before its generation is bound to it, after cleanup revoked the generation's hooks bearer. */
    generationRevoked(generation: string, hooks: { threadId: string; botId: string; token: string }): void {
      revoked.set(generation, hooks);
      for (const oldest of revoked.keys()) if (revoked.size > REVOKED_KEPT) revoked.delete(oldest); else break;
    },
    revokedHooks(generation: string): { threadId: string; botId: string; token: string } | undefined {
      return revoked.get(generation);
    },
    turnEnded,
    /** At a turn's end: its tool calls whose full output is not saved yet, under the turn's hooks bearer (`live` while the
     * bearer is still held, else the one its generation's cleanup set aside). */
    remember(threadId: string, generation: string, turnId: string, live: { botId: string; token: string } | undefined, rows: readonly ToolRow[]): void {
      const hooks = live ?? revoked.get(generation);
      if (hooks) turnEnded({ threadId, botId: hooks.botId, turnId, token: hooks.token, toolUseIds: new Set(rows
        .flatMap((m) => m.kind === "activity" && m.turnId === turnId && m.tool?.itemId && m.tool.fullResult === undefined ? [m.tool.itemId] : [])) });
    },
    /** Security invariant: a capability that is never active, so only the hook route takes it, and only for its ended
     * turn's late tool output. */
    endedTurnCapability(header: string | string[] | undefined) {
      const holder = live().find((candidate) => presents(header, candidate.token));
      return holder ? { botId: holder.botId, threadId: holder.threadId, generation: "ended-turn", depth: 0, kind: "hooks" as const, skillAuthoring: false, createdBots: 0, openedThreads: 0, orphanExpiresAt: 0 } : null;
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
      for (const [generation, hooks] of revoked) if (hooks.threadId === threadId) revoked.delete(generation);
    },
    clear(): void {
      ended.length = 0;
      revoked.clear();
    },
  };
}
