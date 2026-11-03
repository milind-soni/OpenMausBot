// How many threads one bot runs at once.
import { totalmem } from "node:os";

import { engineMemory } from "./engine-memory.ts";

export const MAX_CONCURRENT_BOT_THREADS = 16;
const DEFAULT_THREADS_FLOOR = 3, BYTES_PER_DEFAULT_THREAD = 2 * 1024 ** 3;

/** Where the memory gate runs it decides, so only the ceiling applies; elsewhere nothing protects the machine. */
export interface BotThreadsHost { memoryGate: boolean; totalBytes: number; oneThreadPerBot: boolean }
type SavedThreads = { threads?: { maxConcurrentPerBot?: number } };

export const botThreadsHost = (oneThreadPerBot = false): BotThreadsHost => ({ memoryGate: engineMemory.enabled, totalBytes: totalmem(), oneThreadPerBot });

export function defaultBotThreads(host: Pick<BotThreadsHost, "memoryGate" | "totalBytes"> = botThreadsHost()): number {
  if (host.memoryGate) return MAX_CONCURRENT_BOT_THREADS;
  return Math.min(MAX_CONCURRENT_BOT_THREADS, Math.max(DEFAULT_THREADS_FLOOR, Math.round(host.totalBytes / BYTES_PER_DEFAULT_THREAD)));
}

/** Separate work a person or a routine starts. A plan's limit outranks a saved number. */
export function maxConcurrentBotThreads(cfg: SavedThreads, host: BotThreadsHost = botThreadsHost()): number {
  if (host.oneThreadPerBot) return 1;
  return cfg.threads?.maxConcurrentPerBot ?? defaultBotThreads(host);
}

/** Work a bot's own turn started (its own thread, a hand-off). That turn may be waiting on it, so a plan's limit never holds
 * it behind the turn that started it. */
export function maxConcurrentChildThreads(cfg: SavedThreads, host: BotThreadsHost = botThreadsHost()): number {
  return host.oneThreadPerBot ? MAX_CONCURRENT_BOT_THREADS : maxConcurrentBotThreads(cfg, host);
}

export function botThreadLimitText(cfg: SavedThreads, host: BotThreadsHost = botThreadsHost()): string {
  return host.oneThreadPerBot
    ? "Starter runs one thread at a time per bot — wait for it to finish, or move to a bigger plan to run more"
    : `this bot has reached its limit of ${maxConcurrentBotThreads(cfg, host)} parallel threads — wait for one to finish`;
}
