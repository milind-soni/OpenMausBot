import "../testing/scrub-ambient-omb-env.ts";

import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadlessClient } from "./client.ts";
import type { VerbContext } from "./context.ts";
import { eventsVerb } from "./events.ts";
import { Output, type HeadlessIo } from "./output.ts";

afterEach(() => vi.useRealTimers());

function context(response: () => Response, onProgress: () => void = () => undefined) {
  const controller = new AbortController();
  const raw = vi.fn(async () => response());
  const client: HeadlessClient = {
    baseUrl: "http://127.0.0.1:1", explicit: true,
    json: async <T>() => ({} as T), tool: async () => ({}), raw,
  };
  const io: HeadlessIo = { out: () => undefined, err: onProgress, readStdin: async () => "" };
  const ctx: VerbContext = {
    verb: "events", flags: {}, positionals: [], env: {}, io,
    output: new Output(io, {}), client: async () => client,
    signal: controller.signal, defaultWaitMs: 1_000,
  };
  return { ctx, controller, raw };
}

describe("event failure response bodies", () => {
  it("releases each unfinished retryable response before reconnecting", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const f = context(() => new Response(new ReadableStream({ cancel }), { status: 503 }));
    const running = eventsVerb(f.ctx);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.raw).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      f.controller.abort();
      await running;
    }
  });

  it("still retries when cancelling a failed response rejects", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => { throw new Error("already disconnected"); });
    const f = context(() => new Response(new ReadableStream({ cancel }), { status: 502 }));
    const running = eventsVerb(f.ctx);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.raw).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      f.controller.abort();
      await running;
    }
  });

  it.each(["null", "42", '"refused"', "[]", "not JSON"])("treats a 403 as final even when its body is %s", async (body) => {
    const f = context(() => new Response(body, { status: 403 }), () => f.controller.abort());
    await expect(eventsVerb(f.ctx)).rejects.toMatchObject({ status: 403, message: "the event stream was refused (403)" });
    expect(f.raw).toHaveBeenCalledTimes(1);
  });

  it("keeps a bounded JSON refusal message, including split UTF-8", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ error: "会话已过期" }));
    const response = new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { status: 401 });
    const f = context(() => response);
    await expect(eventsVerb(f.ctx)).rejects.toMatchObject({ status: 401, message: "the event stream was refused: 会话已过期" });
    expect(response.body?.locked).toBe(false);
  });

  it("stops reading an oversized refusal without waiting for the rest", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('{"error":"' + "x".repeat(17 * 1024)));
      }, cancel,
    }), { status: 403 });
    const f = context(() => response);
    let failure: unknown;
    const running = eventsVerb(f.ctx).catch((error: unknown) => { failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(failure).toMatchObject({ status: 403 });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.controller.abort();
      streamController!.error(new Error("fixture cleanup"));
      await running;
    }
  });

  it("bounds a stalled refusal read and removes its timer and abort listener", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; }, cancel }), { status: 403 });
    const f = context(() => response);
    let failure: unknown;
    const running = eventsVerb(f.ctx).catch((error: unknown) => { failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(failure).toMatchObject({ status: 403 });
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body?.locked).toBe(false);
      expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.controller.abort();
      streamController!.error(new Error("fixture cleanup"));
      await running;
    }
  });

  it("cancels a stalled refusal immediately when the command is stopped", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; }, cancel }), { status: 403 });
    const f = context(() => response);
    let exitCode: number | undefined;
    const running = eventsVerb(f.ctx).then((result) => { exitCode = result.exitCode; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      f.controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(exitCode).toBe(130);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      streamController!.error(new Error("fixture cleanup"));
      await running;
    }
  });
});
