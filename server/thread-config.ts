import { z } from "zod";
import { MAX_CONCURRENT_BOT_THREADS } from "./bot-thread-limits.ts";

/** The floor keeps a log tail large enough for the event inspector's recent-line window. */
export const MIN_THREAD_EVENT_LOG_BYTES = 256 * 1024;
export const MAX_THREAD_EVENT_LOG_BYTES = 4 * 1024 * 1024 * 1024;

export const threadsConfigSchema = z.object({
  maxConcurrentPerBot: z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS),
  /** Byte cap for each thread's events/ and native/ log; absent means unbounded. */
  eventLogMaxBytes: z.number().int().min(MIN_THREAD_EVENT_LOG_BYTES).max(MAX_THREAD_EVENT_LOG_BYTES).optional(),
  /** Days a closed or archived thread's event logs survive; absent keeps them forever. */
  eventLogRetentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();

export const threadsPatchSchema = threadsConfigSchema.extend({
  maxConcurrentPerBot: threadsConfigSchema.shape.maxConcurrentPerBot.optional(),
  eventLogMaxBytes: threadsConfigSchema.shape.eventLogMaxBytes.nullable(),
  eventLogRetentionDays: threadsConfigSchema.shape.eventLogRetentionDays.nullable(),
});

export type ThreadsConfig = z.output<typeof threadsConfigSchema>;
type Config = { threads?: ThreadsConfig; routineExecutionRetentionDays?: number | null };

export function threadEventLogMaxBytes(cfg: Config): number | null {
  const cap = cfg.threads?.eventLogMaxBytes;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null;
}

export function threadEventLogRetentionDays(cfg: Config): number | null {
  return cfg.threads?.eventLogRetentionDays ?? null;
}

export function threadConfigStatus(cfg: Config, maxConcurrentPerBot: number) {
  const eventLogMaxBytes = threadEventLogMaxBytes(cfg);
  const eventLogRetentionDays = threadEventLogRetentionDays(cfg);
  return {
    maxConcurrentPerBot,
    routineExecutionRetentionSupported: true as const,
    ...(eventLogMaxBytes !== null ? { eventLogMaxBytes } : {}),
    ...(eventLogRetentionDays !== null ? { eventLogRetentionDays } : {}),
    ...(cfg.routineExecutionRetentionDays != null
      ? { routineExecutionRetentionDays: cfg.routineExecutionRetentionDays } : {}),
  };
}
