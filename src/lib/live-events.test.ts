import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_EVENTS_STALE_MS,
  isLivePing,
  liveEventsUrl,
  openLiveEvents,
  shouldReconnectLiveEvents,
  type LiveEventSourceLike,
  type LiveEventsPlatform,
} from "./live-events";

class FakeTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  open() {
    this.onopen?.();
  }

  error() {
    this.onerror?.();
  }

  message<T extends { kind: string }>(frame: T, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

function harness(options?: { online?: boolean; visible?: boolean; now?: number }) {
  const sources: FakeEventSource[] = [];
  const windowTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  let online = options?.online ?? true;
  let visible = options?.visible ?? true;
  let now = options?.now ?? 0;
  const platform: LiveEventsPlatform = {
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    windowTarget,
    documentTarget,
    isOnline: () => online,
    isVisible: () => visible,
    now: () => now,
  };
  return {
    sources,
    platform,
    windowTarget,
    documentTarget,
    setOnline(value: boolean) {
      online = value;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live events URL", () => {
  it("builds cold, resumable, and screen-free stream URLs", () => {
    expect(liveEventsUrl()).toBe("/api/events");
    expect(liveEventsUrl({ screens: true })).toBe("/api/events");
    expect(liveEventsUrl({ since: "ab12cd34:9" })).toBe("/api/events?since=ab12cd34%3A9");
    expect(liveEventsUrl({ since: "ab12cd34:9", screens: false })).toBe(
      "/api/events?since=ab12cd34%3A9&screens=off",
    );
    expect(liveEventsUrl({ screens: false })).toBe("/api/events?screens=off");
  });
});

describe("live events supervisor", () => {
  it("uses data pings as liveness without forwarding them", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );

    expect(test.sources).toHaveLength(1);
    test.sources[0].open();
    test.sources[0].message({ kind: "message" }, "run00000:4");
    test.setNow(900);
    test.sources[0].message({ kind: "ping" }, "run00000:999");
    vi.advanceTimersByTime(1_500);
    test.setNow(1_899);
    expect(test.sources).toHaveLength(1);
    expect(onFrame).toHaveBeenCalledOnce();

    test.setNow(1_900);
    vi.advanceTimersByTime(500);
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4");
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("ignores frames from a stream generation after replacing it", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, retryMinMs: 100, retryMaxMs: 100 },
      test.platform,
    );
    const staleHandler = test.sources[0].onmessage;

    test.sources[0].error();
    vi.advanceTimersByTime(100);
    staleHandler?.({ data: JSON.stringify({ kind: "message", value: "stale" }), lastEventId: "old:9" });
    test.sources[1].message({ kind: "message", value: "current" }, "new:1");

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledWith({ kind: "message", value: "current" });
    stop();
  });

  it("commits a refused-resume boundary only after its replacement snapshot succeeds", async () => {
    const test = harness();
    const frames: unknown[] = [];
    const snapshotResolutions: Array<(loaded: boolean) => void> = [];
    const stop = openLiveEvents(
      {
        onFrame: (frame) => frames.push(frame),
        onSnapshotRequired: () =>
          new Promise<boolean>((resolve) => snapshotResolutions.push(resolve)),
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.sources[0].message({ kind: "message" }, "oldrun00:10");
    test.sources[0].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[1].url).toBe("/api/events?since=oldrun00%3A10");

    // The server has three replay frames queued. If the socket dies before
    // they arrive, the next attempt still asks from the last consumed frame.
    test.sources[1].message({ kind: "hello", resumed: true, cursor: "oldrun00:13" });
    test.sources[1].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[2].url).toBe("/api/events?since=oldrun00%3A10");

    // A restart/expired replay window has no frames to replay. Application
    // frames may arrive while the consumer rebuilds, but neither their id nor
    // the hello boundary is safe until that replacement snapshot succeeds.
    test.sources[2].message({ kind: "hello", resumed: false, cursor: "newrun00:7" });
    test.sources[2].message({ kind: "message", value: "behind failed snapshot" }, "newrun00:8");
    snapshotResolutions.shift()?.(false);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(test.sources[3].url).toBe("/api/events?since=oldrun00%3A10");

    test.sources[3].message({ kind: "hello", resumed: false, cursor: "newrun00:8" });
    test.sources[3].message({ kind: "message", value: "after snapshot" }, "newrun00:9");
    snapshotResolutions.shift()?.(true);
    await Promise.resolve();
    test.sources[3].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[4].url).toBe("/api/events?since=newrun00%3A9");
    expect(frames).toEqual([
      { kind: "message" },
      { kind: "message", value: "behind failed snapshot" },
      { kind: "message", value: "after snapshot" },
    ]);
    stop();
  });

  it("caps retry backoff when opening the stream keeps failing", () => {
    const attempts: number[] = [];
    const onError = vi.fn();
    const platform: LiveEventsPlatform = {
      createEventSource: () => {
        attempts.push(Date.now());
        throw new Error("offline");
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };

    vi.setSystemTime(0);
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        onError,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      platform,
    );
    vi.advanceTimersByTime(1_100);

    expect(attempts).toEqual([0, 100, 300, 700, 1_100]);
    expect(onError).toHaveBeenCalledTimes(5);
    stop();
  });

  it("backs off an open/error flap until the stream survives a heartbeat", () => {
    const test = harness();
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      test.platform,
    );

    test.sources[0].open();
    test.sources[0].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    test.sources[1].open();
    test.sources[1].error();
    vi.advanceTimersByTime(199);
    expect(test.sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    test.sources[2].open();
    test.sources[2].message({ kind: "ping" });
    test.sources[2].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(test.sources).toHaveLength(4);
    stop();
  });

  it("does not churn a suspended hidden stream and recovers once visible", () => {
    const test = harness({ visible: false });
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        staleMs: 1_000,
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.setNow(10_000);
    vi.advanceTimersByTime(10_000);
    expect(test.sources).toHaveLength(1);

    // Even an explicit transport error stays quiet in the background; the
    // visibility edge below is the single owner of recovery.
    test.sources[0].error();
    vi.advanceTimersByTime(1_000);
    expect(test.sources).toHaveLength(1);

    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("recovers immediately on online/focus/visible and removes every owner on cleanup", () => {
    const test = harness({ online: false });
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );
    expect(test.sources).toHaveLength(0);

    test.setOnline(true);
    test.windowTarget.emit("online");
    expect(test.sources).toHaveLength(1);

    test.setNow(1_001);
    test.windowTarget.emit("focus");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();

    test.setVisible(false);
    test.setNow(2_002);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(3);

    stop();
    stop();
    expect(test.sources[2].close).toHaveBeenCalledOnce();
    expect(test.windowTarget.count("online")).toBe(0);
    expect(test.windowTarget.count("focus")).toBe(0);
    expect(test.documentTarget.count("visibilitychange")).toBe(0);
  });
});

describe("live event liveness predicates", () => {
  it("recognizes only ping frames and reconnects at the stale boundary", () => {
    expect(isLivePing({ kind: "ping" })).toBe(true);
    expect(isLivePing({ kind: "message" })).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS - 1)).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS)).toBe(true);
  });
});
