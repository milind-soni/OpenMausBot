// The bus is the seam every client depends on: events must arrive
// stamped with their instanceId, cross-driver leaks must be dropped, and
// neither logging nor a broken listener may take down the stream.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { EventBus } from "./bus.ts";

const testEvent = (over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({
    eventId: "ev-1",
    provider: "fake",
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    type: "turn.started",
    ...over,
  }) as RuntimeEvent;

async function liveInstance() {
  const fake = makeFakeDriver();
  await fake.driver.create({
    instanceId: "inst-1",
    displayName: undefined,
    environment: {},
    enabled: true,
    config: {},
  });
  return fake.created.get("inst-1")!;
}

describe("EventBus", () => {
  beforeEach(() => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    ensureDirs();
  });

  it("stamps events from an attached adapter with the instanceId", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-1");
    await bus.flush();
  });

  it("drops events claiming a different driver kind (cross-driver invariant)", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ provider: "impostor" }));
    expect(seen).toHaveLength(0);
  });

  it("tees every published event to the per-thread NDJSON log", async () => {
    const bus = new EventBus();
    bus.publish(testEvent({ threadId: "log-me" }));
    await bus.flush();

    const logged = readFileSync(join(EVENTS_DIR, "log-me.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("turn.started");
  });

  it("redacts credential-shaped content before writing the NDJSON log", async () => {
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const bus = new EventBus();
    bus.publish(testEvent({
      threadId: "redacted-log",
      type: "runtime.error",
      message: `provider returned ${key}`,
    }));
    await bus.flush();

    const logged = readFileSync(join(EVENTS_DIR, "redacted-log.ndjson"), "utf8");
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
  });

  it("reports an incomplete log once while continuing live delivery", async () => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));
    expect(seen.map((event) => event.eventId)).toEqual(["ev-1", "ev-2"]);
    await bus.flush();

    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    expect(existsSync(EVENTS_DIR)).toBe(false);
  });

  it("writes the incomplete marker before the first event after logging recovers", async () => {
    let failing = true;
    const writes: string[] = [];
    const append = vi.fn((_path: string, data: string) => {
      if (failing) throw new Error("disk full");
      writes.push(data);
    });
    const bus = new EventBus(append);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(testEvent());
    await bus.flush();
    failing = false;
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));
    await bus.flush();
    bus.publish(testEvent({ eventId: "ev-3" }));
    await bus.flush();

    const recovered = writes[0].trim().split("\n").map((line) => JSON.parse(line));
    expect(recovered.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(recovered[0].message).toContain("event history is incomplete");
    expect(writes[1].trim()).toContain('"eventId":"ev-3"');
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("a throwing listener does not starve the others", async () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
    await bus.flush();
  });

  it("unsubscribe and detachAll stop delivery", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    unsub();
    emit(testEvent());
    expect(seen).toHaveLength(1);

    const seenAfterDetach: RuntimeEvent[] = [];
    bus.subscribe((e) => seenAfterDetach.push(e));
    bus.detachAll();
    emit(testEvent());
    expect(seenAfterDetach).toHaveLength(0);
    await bus.flush();
  });

  it("batches adjacent lines in publish order and flushes them on a terminal event", async () => {
    const writes: string[] = [];
    const append = vi.fn((_path: string, data: string) => {
      writes.push(data);
    });
    const bus = new EventBus(append);
    bus.publish(testEvent({ eventId: "a" }));
    bus.publish(testEvent({ eventId: "b" }));
    bus.publish(testEvent({ eventId: "c", type: "turn.completed", ok: true }));
    await bus.flush();

    expect(append).toHaveBeenCalledTimes(1);
    const ids = writes[0].trim().split("\n").map((line) => JSON.parse(line).eventId as string);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("keeps later lines behind an append that is still in flight", async () => {
    let release: (() => void) | undefined;
    const writes: string[] = [];
    const append = vi.fn((_path: string, data: string) => {
      if (!release) {
        return new Promise<void>((resolve) => {
          release = () => {
            writes.push(data);
            resolve();
          };
        });
      }
      writes.push(data);
    });
    const bus = new EventBus(append);
    bus.publish(testEvent({ eventId: "a" }));
    bus.publish(testEvent({ eventId: "b" }));
    await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(1);
    bus.publish(testEvent({ eventId: "c" }));
    release?.();
    await bus.flush();

    const ids = writes.flatMap((chunk) => chunk.trim().split("\n").map((line) => JSON.parse(line).eventId as string));
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("stops queueing once the log buffer is full and warns once", async () => {
    const writes: string[] = [];
    const append = vi.fn((_path: string, data: string) => {
      writes.push(data);
    });
    const bus = new EventBus(append);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    for (let i = 0; i < 260; i++) bus.publish(testEvent({ eventId: `e${i}` }));
    await bus.flush();

    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    const lines = writes.flatMap((chunk) => chunk.trim().split("\n").map((line) => JSON.parse(line) as { eventId: string; type: string }));
    const kept = lines.filter((line) => /^e\d+$/.test(line.eventId)).map((line) => line.eventId);
    expect(kept).toEqual(Array.from({ length: 256 }, (_, i) => `e${i}`));
    expect(lines.some((line) => line.type === "runtime.error")).toBe(true);
    expect(kept).not.toContain("e256");
  });

  it("keeps publication order in the log when a listener publishes from inside delivery", async () => {
    const writes: string[] = [];
    const bus = new EventBus((_path: string, data: string) => { writes.push(data); });
    const seen: string[] = [];
    bus.subscribe((event) => {
      seen.push(event.eventId);
      if (event.eventId === "a") bus.publish(testEvent({ eventId: "nested", type: "runtime.notice", message: "from a listener" } as Partial<RuntimeEvent>));
    });
    bus.publish(testEvent({ eventId: "a" }));
    bus.publish(testEvent({ eventId: "b" }));
    await bus.flush();

    const ids = writes.flatMap((chunk) => chunk.trim().split("\n").map((line) => JSON.parse(line).eventId as string));
    expect(ids).toEqual(["a", "nested", "b"]);
    expect(seen).toEqual(["a", "nested", "b"]);
  });

  it("never drops a turn's end when the log buffer is full, and marks the gap right before it", async () => {
    const writes: string[] = [];
    const bus = new EventBus((_path: string, data: string) => { writes.push(data); });
    for (let i = 0; i < 260; i++) bus.publish(testEvent({ eventId: `e${i}` }));
    bus.publish(testEvent({ eventId: "done", type: "turn.completed", ok: true } as Partial<RuntimeEvent>));
    // Another thread's end, with nothing of its own lost, lands unmarked.
    bus.publish(testEvent({ eventId: "other-done", threadId: "thread-2", type: "turn.completed", ok: true } as Partial<RuntimeEvent>));
    bus.publish(testEvent({ eventId: "error-end", threadId: "thread-3", type: "runtime.error", message: "boom", terminal: true } as Partial<RuntimeEvent>));
    await bus.flush();

    const lines = writes.flatMap((chunk) => chunk.trim().split("\n").map((line) => JSON.parse(line) as { eventId: string; threadId: string; type: string; message?: string }));
    const first = lines.filter((line) => line.threadId === "thread-1");
    expect(first.slice(0, 256).map((line) => line.eventId)).toEqual(Array.from({ length: 256 }, (_, i) => `e${i}`));
    expect(first.slice(256).map((line) => line.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(first.at(-1)!.eventId).toBe("done");
    expect(lines.filter((line) => line.threadId === "thread-2").map((line) => line.eventId)).toEqual(["other-done"]);
    expect(lines.filter((line) => line.threadId === "thread-3").map((line) => line.eventId)).toEqual(["error-end"]);
  });

  it("bounds the shutdown flush and says when the log did not finish", async () => {
    const stuck = new EventBus(() => new Promise<void>(() => {}));
    stuck.publish(testEvent({ eventId: "never" }));
    await expect(stuck.flushWithin(20)).resolves.toBe(false);

    const writes: string[] = [];
    const healthy = new EventBus((_path: string, data: string) => { writes.push(data); });
    healthy.publish(testEvent({ eventId: "landed" }));
    await expect(healthy.flushWithin(1_000)).resolves.toBe(true);
    expect(writes.join("")).toContain('"eventId":"landed"');
  });

  it("keeps the overflow marker before newly accepted events after the gap", async () => {
    const writes: string[] = [];
    let release!: () => void;
    const bus = new EventBus((_path, data) => {
      writes.push(data);
      if (writes.length === 1) return new Promise<void>(resolve => { release = resolve; });
    });
    for (let i = 0; i < 260; i++) bus.publish(testEvent({ eventId: `e${i}` }));
    await Promise.resolve(); // The active batch frees room for another event.
    bus.publish(testEvent({ eventId: "after-gap" }));
    release();
    await bus.flush();
    const lines = writes.flatMap(chunk => chunk.trim().split("\n").map(line => JSON.parse(line)));
    expect(lines.slice(0, 256).map(event => event.eventId)).toEqual(Array.from({ length: 256 }, (_, i) => `e${i}`));
    expect(lines[256].type).toBe("runtime.error");
    expect(lines[257].eventId).toBe("after-gap");
  });

  it("does not put an overflow marker before accepted events already in the active batch", async () => {
    const writes: string[] = [];
    let release!: () => void;
    const bus = new EventBus((_path, data) => {
      writes.push(data);
      if (writes.length === 1) return new Promise<void>(resolve => { release = resolve; });
    });
    bus.publish(testEvent({ threadId: "other", eventId: "blocking" }));
    bus.publish(testEvent({ eventId: "before-gap" }));
    await Promise.resolve();
    for (let i = 0; i < 256; i++) bus.publish(testEvent({ threadId: "other", eventId: `e${i}` }));
    bus.publish(testEvent({ eventId: "dropped" }));
    bus.publish(testEvent({ eventId: "done", type: "turn.completed", ok: true }));
    release();
    await bus.flush();
    const lines = writes.flatMap(chunk => chunk.trim().split("\n").map(line => JSON.parse(line)))
      .filter(event => event.threadId === "thread-1");
    expect(lines.map(event => event.type)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(lines[0].eventId).toBe("before-gap");
  });

  it("does not report a successful shutdown flush after an append fails", async () => {
    let failing = true;
    const writes: string[] = [];
    const bus = new EventBus((_path, data) => {
      if (failing) throw new Error("disk full");
      writes.push(data);
    });
    bus.publish(testEvent());
    await expect(bus.flushWithin(1_000)).resolves.toBe(false);
    await expect(bus.flushWithin(1_000)).resolves.toBe(false);
    failing = false;
    bus.publish(testEvent({ eventId: "recovered" }));
    await expect(bus.flushWithin(1_000)).resolves.toBe(true);
    expect(writes.join("")).toContain("event history is incomplete");
  });

  it("flushes queued lines when an instance detaches", async () => {
    const bus = new EventBus();
    bus.publish(testEvent({ threadId: "detach-me", eventId: "d1" }));
    bus.detach("missing");
    await bus.flush();

    const logged = readFileSync(join(EVENTS_DIR, "detach-me.ndjson"), "utf8");
    expect(logged).toContain('"eventId":"d1"');
  });
});

// A provider streams a reply as many small text deltas. The bus publishes
// them merged, at most one per thread every 50 ms, so the log, the listeners
// and every connected client handle a few frames per second instead of one
// per token. Nothing else is delayed, and nothing changes order.
describe("EventBus streamed text", () => {
  const delta = (text: string, over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
    testEvent({ type: "content.delta", streamKind: "assistant_text", delta: text, turnId: "turn-1", ...over } as Partial<RuntimeEvent>);
  const logged = (threadId: string) =>
    readFileSync(join(EVENTS_DIR, `${threadId}.ndjson`), "utf8").trim().split("\n").map((line) => JSON.parse(line) as RuntimeEvent);
  const summary = (events: RuntimeEvent[]) =>
    events.map((event) => (event.type === "content.delta" ? `${event.threadId}:${event.streamKind}:${event.delta}` : `${event.threadId}:${event.type}`));

  beforeEach(() => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    ensureDirs();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges deltas that arrive within 50 ms into one event, logged once", async () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(delta("Hel", { eventId: "d1" }));
    bus.publish(delta("lo, ", { eventId: "d2" }));
    vi.advanceTimersByTime(30);
    bus.publish(delta("world", { eventId: "d3" }));
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(20);
    expect(summary(seen)).toEqual(["thread-1:assistant_text:Hello, world"]);
    expect(seen[0]).toMatchObject({ eventId: "d1", turnId: "turn-1" });
    await bus.flush();
    expect(summary(logged("thread-1"))).toEqual(["thread-1:assistant_text:Hello, world"]);

    bus.publish(delta("!", { eventId: "d4" }));
    vi.advanceTimersByTime(50);
    expect(summary(seen)).toEqual(["thread-1:assistant_text:Hello, world", "thread-1:assistant_text:!"]);
    await bus.flush();
  });

  it("publishes the waiting text before any other event on that thread", async () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(delta("Let me check"));
    bus.publish(testEvent({ eventId: "tool", type: "item.started", itemType: "tool", title: "Read", turnId: "turn-1" }));
    bus.publish(delta("Done"));
    bus.publish(testEvent({ eventId: "text", type: "item.completed", itemType: "assistant_text", text: "Let me check Done", turnId: "turn-1" }));
    bus.publish(delta(" late"));
    bus.publish(testEvent({ eventId: "end", type: "turn.completed", ok: true, turnId: "turn-1" }));

    const expected = [
      "thread-1:assistant_text:Let me check", "thread-1:item.started", "thread-1:assistant_text:Done",
      "thread-1:item.completed", "thread-1:assistant_text: late", "thread-1:turn.completed",
    ];
    expect(summary(seen)).toEqual(expected);
    await bus.flush();
    expect(summary(logged("thread-1"))).toEqual(expected);
  });

  it("never merges across threads, stream kinds, turns or synthetic text", async () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(delta("a1"));
    bus.publish(delta("b1", { threadId: "thread-2" }));
    bus.publish(delta("thinking", { streamKind: "reasoning_text" }));
    bus.publish(delta("a2"));
    bus.publish(delta("next turn", { turnId: "turn-2" }));
    bus.publish(delta("api error", { turnId: "turn-2", synthetic: true }));
    bus.publish(delta("b2", { threadId: "thread-2" }));
    expect(summary(seen)).toEqual(["thread-1:assistant_text:a1", "thread-1:reasoning_text:thinking", "thread-1:assistant_text:a2", "thread-1:assistant_text:next turn"]);

    vi.advanceTimersByTime(50);
    expect(summary(seen).slice(4).sort()).toEqual(["thread-1:assistant_text:api error", "thread-2:assistant_text:b1b2"]);
    expect(seen.find((event) => event.type === "content.delta" && event.delta === "api error")?.synthetic).toBe(true);
    await bus.flush();
  });

  it("publishes waiting text on detach and on flush", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    emit(delta("from the adapter"));
    bus.publish(delta("other engine", { threadId: "thread-2", providerInstanceId: "inst-2" }));
    bus.detach("inst-1");
    expect(summary(seen)).toEqual(["thread-1:assistant_text:from the adapter", "thread-2:assistant_text:other engine"]);

    // the server calls flush() as the process exits
    bus.publish(delta("last words", { threadId: "thread-3" }));
    bus.flush();
    expect(summary(seen).at(-1)).toBe("thread-3:assistant_text:last words");
    vi.advanceTimersByTime(100);
    expect(seen).toHaveLength(3);
    await bus.flush();
  });
});
