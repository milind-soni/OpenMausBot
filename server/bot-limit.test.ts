import { expect, it } from "vitest";

import { botLimitRefusal } from "./bot-limit.ts";
import { threadEventLogMaxBytes, type AppConfig } from "./config.ts";
import { DEFAULT_THREAD_EVENT_LOG_MAX_BYTES, threadLogCapOrDefault } from "./thread-log-rotation.ts";

it("a workspace at its bot limit says the limit and what to do about it", () => {
  expect(botLimitRefusal(100)).toMatch(/already has 100 bots.*To add another, delete a bot you no longer need, or create the new bots in another workspace\./);
});

it("event logs are trimmed past a default ceiling where no limit is set, and past the person's limit where one is", () => {
  const none = {} as AppConfig, set = { threads: { maxConcurrentPerBot: 2, eventLogMaxBytes: 1024 * 1024 } } as AppConfig;
  expect(threadEventLogMaxBytes(none)).toBeNull();
  expect(threadLogCapOrDefault(threadEventLogMaxBytes(none))).toBe(DEFAULT_THREAD_EVENT_LOG_MAX_BYTES);
  expect(threadLogCapOrDefault(threadEventLogMaxBytes(set))).toBe(1024 * 1024);
});
