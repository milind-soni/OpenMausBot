// The bus is the seam every client depends on: events must arrive
// stamped with their instanceId, cross-driver leaks must be dropped, and
// neither logging nor a broken listener may take down the stream.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { EventBus, internalRuntimeTurnToken } from "./bus.ts";

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

  it("tees every published event to the per-thread NDJSON log", () => {
    const bus = new EventBus();
    bus.publish(testEvent({ threadId: "log-me" }));

    const logged = readFileSync(join(EVENTS_DIR, "log-me.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("turn.started");
  });

  it("redacts credential-shaped content before writing the NDJSON log", () => {
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const bus = new EventBus();
    bus.publish(testEvent({
      threadId: "redacted-log",
      type: "runtime.error",
      message: `provider returned ${key}`,
    }));

    const logged = readFileSync(join(EVENTS_DIR, "redacted-log.ndjson"), "utf8");
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
  });

  it("redacts exact protected values before logging or transcript delivery", () => {
    const canary = "exact-canary-value-847263";
    process.env.BUS_TEST_API_KEY = canary;
    try {
      const bus = new EventBus();
      const seen: RuntimeEvent[] = [];
      bus.subscribe((event) => seen.push(event));
      bus.publish(testEvent({
        threadId: "known-value-redaction",
        type: "item.completed",
        itemType: "assistant_text",
        text: `copied ${canary}`,
      }));

      const logged = readFileSync(join(EVENTS_DIR, "known-value-redaction.ndjson"), "utf8");
      expect(logged).not.toContain(canary);
      expect(JSON.stringify(seen)).not.toContain(canary);
      expect(logged).toContain("redacted");
    } finally {
      delete process.env.BUS_TEST_API_KEY;
    }
  });

  it("keeps a turn lease available only as non-serializable in-process proof", () => {
    const rawToken = "turn-token-exact-internal-proof-1234567890";
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(testEvent({ threadId: "turn-token-proof", turnToken: rawToken }));

    expect(seen).toHaveLength(1);
    expect(internalRuntimeTurnToken(seen[0]!)).toBe(rawToken);
    expect(seen[0]!.turnToken).not.toBe(rawToken);
    expect(JSON.stringify(seen[0])).not.toContain(rawToken);
    expect(readFileSync(join(EVENTS_DIR, "turn-token-proof.ndjson"), "utf8")).not.toContain(rawToken);
    expect(Object.keys(seen[0]!)).not.toContain("openmaus.internal-runtime-turn-token");
  });

  it("drops a guard-rejected event before logging or subscriber delivery", () => {
    const rawToken = "turn-token-wrong-owner-proof-1234567890";
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.addAdmissionGuard((event) => internalRuntimeTurnToken(event) !== rawToken);
    bus.subscribe((event) => seen.push(event));

    bus.publish(testEvent({ threadId: "guard-rejected", turnToken: rawToken }));

    expect(seen).toEqual([]);
    expect(existsSync(join(EVENTS_DIR, "guard-rejected.ndjson"))).toBe(false);
  });

  it("still delivers when the NDJSON log cannot be written", () => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
    expect(existsSync(EVENTS_DIR)).toBe(false);
  });

  it("a throwing listener does not starve the others", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
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
  });
});
