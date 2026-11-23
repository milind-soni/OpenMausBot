import { api } from "@/state/api";
import type { BotComputerRow, BotComputersPayload } from "../../shared/bot-computers";

export type { BotComputerKind, BotComputerRow, BotComputersPayload, BotComputerState } from "../../shared/bot-computers";

/** Which computer each bot (and each chat with a place of its own) works on, from what the server already holds. A
 * poll is `background`, so it never wakes a Cloud home that went to sleep. */
export function fetchBotComputers(init: { signal?: AbortSignal; background?: boolean } = {}): Promise<BotComputersPayload> {
  return api<BotComputersPayload>("/api/computers/bots", { signal: init.signal ?? AbortSignal.timeout(15_000), background: init.background ?? true });
}

/** The row for a bot's own place, or for one of its chats when that chat has its own. */
export function botComputerFor(rows: readonly BotComputerRow[], botId: string, threadId?: string): BotComputerRow | undefined {
  return (threadId ? rows.find((row) => row.botId === botId && row.threadId === threadId) : undefined)
    ?? rows.find((row) => row.botId === botId && row.threadId === undefined);
}
