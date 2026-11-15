import "../testing/scrub-ambient-omb-env.ts";

import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadlessClient } from "./client.ts";
import type { VerbContext } from "./context.ts";
import { eventsVerb } from "./events.ts";
import { Output, type HeadlessIo } from "./output.ts";

afterEach(() => vi.useRealTimers());

function fixture(onProgress: () => void = () => undefined) {
  const controller = new AbortController();
  let streamSignal: AbortSignal | undefined;
  let attempts = 0;
  const io: HeadlessIo = { out: () => undefined, err: onProgress, readStdin: async () => "" };
  const client: HeadlessClient = {
    baseUrl: "http://127.0.0.1:1", explicit: true,
    json: async <T>() => ({} as T),
    tool: async () => ({}),
    raw: async (_path, init) => {
      attempts++;
      streamSignal = init?.signal ?? undefined;
      return new Response(null, { status: 503 });
    },
  };
  const ctx: VerbContext = {
    verb: "events", flags: {}, positionals: [], env: {}, io,
    output: new Output(io, {}), client: async () => client,
    signal: controller.signal, defaultWaitMs: 1_000,
  };
  return { controller, ctx, signal: () => streamSignal!, attempts: () => attempts };
}

describe("event reconnect backoff lifecycle", () => {
  it("keeps only the current abort listener across reconnect attempts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const running = eventsVerb(f.ctx);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.attempts()).toBe(1);
      expect(getEventListeners(f.signal(), "abort")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.attempts()).toBe(2);
      expect(getEventListeners(f.signal(), "abort")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.attempts()).toBe(3);
      expect(getEventListeners(f.signal(), "abort")).toHaveLength(1);
    } finally {
      f.controller.abort();
      await vi.runAllTimersAsync();
      expect((await running).exitCode).toBe(130);
      expect(getEventListeners(f.signal(), "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("does not start a backoff after progress reporting cancels the command", async () => {
    vi.useFakeTimers();
    const f = fixture(() => f.controller.abort());
    const running = eventsVerb(f.ctx);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.attempts()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(f.signal(), "abort")).toHaveLength(0);
    } finally {
      await vi.runAllTimersAsync();
      expect((await running).exitCode).toBe(130);
    }
  });
});
