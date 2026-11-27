import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_EVENTS_STALE_MS,
  isLivePing,
  listenLiveFrames,
  liveEventsUrl,
  livePhase,
  openLiveEvents,
  retryLiveEvents,
  shouldReconnectLiveEvents,
  type LiveEventSourceLike,
  type LiveEventsPlatform,
} from "./live-events";
import { cloudAsleep, markCloudAwake, resetCloudPowerForTests } from "./cloud-power";
import { setRelayLink } from "./relay-server";
import { resetTurnLive, turnLive } from "@/state/turn-status";

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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setRelayLink(null); resetCloudPowerForTests(); });

describe("live events URL", () => {
  it("builds cold and resumable stream URLs", () => {
    expect(liveEventsUrl()).toBe("/api/events?window=1&frames=thread");
    expect(liveEventsUrl({ since: "ab12cd34:9" })).toBe("/api/events?since=ab12cd34%3A9&window=1&frames=thread");
    expect(liveEventsUrl({ since: "ab12cd34:9", screens: false })).toBe("/api/events?since=ab12cd34%3A9&screens=off&window=1&frames=thread");
    expect(liveEventsUrl({ screens: true })).toBe("/api/events?window=1&frames=thread");
  });
});

describe("the chat's status line", () => {
  it("reads each live runtime frame before the app does", () => {
    resetTurnLive();
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents({ onFrame, onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].open();
    const event = { eventId: "e1", provider: "claudeAgent", threadId: "t1", createdAt: "2026-10-23T12:00:00.000Z", turnId: "u1" };
    test.sources[0].message({ kind: "runtime", event: { ...event, type: "turn.progress", activity: "write", itemId: "w", file: "index.html", bytes: 14_336 } }, "run00000:1");
    expect(turnLive("t1").status).toEqual({ activity: "write", itemId: "w", file: "index.html", bytes: 14_336 });
    test.sources[0].message({ kind: "runtime", event: { ...event, eventId: "e2", type: "turn.completed", ok: true } }, "run00000:2");
    expect(turnLive("t1")).toMatchObject({ ended: true, status: null });
    expect(onFrame).toHaveBeenCalledTimes(2);
    stop();
    resetTurnLive();
  });
});

describe("live events supervisor", () => {
  it("retries immediately with its saved cursor, cancels backoff, and removes the retry listener on stop", () => {
    const test = harness();
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => test.windowTarget.emit(event.type),
      addEventListener: test.windowTarget.addEventListener.bind(test.windowTarget),
      removeEventListener: test.windowTarget.removeEventListener.bind(test.windowTarget),
    });
    const onFrame = vi.fn();
    const stop = openLiveEvents({ onFrame, onSnapshotRequired: async () => true }, test.platform);
    try {
      test.sources[0].open();
      test.sources[0].message({ kind: "message" }, "run00000:4");
      test.sources[0].error();
      retryLiveEvents();
      expect(test.sources).toHaveLength(2);
      expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4&screens=off&window=1&frames=thread");
      test.sources[1].open();
      test.sources[1].message({ kind: "ping" });
      vi.advanceTimersByTime(500);
      expect(test.sources).toHaveLength(2);
      expect(onFrame).toHaveBeenCalledOnce();
      stop();
      retryLiveEvents();
      expect(test.sources).toHaveLength(2);
      expect(test.windowTarget.count("omb:retry-live-events")).toBe(0);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });

  it.each(["offline", "hidden", "asleep"])("does not manually reconnect while %s", (state) => {
    const test = harness();
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => test.windowTarget.emit(event.type),
      addEventListener: test.windowTarget.addEventListener.bind(test.windowTarget),
      removeEventListener: test.windowTarget.removeEventListener.bind(test.windowTarget),
    });
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    try {
      if (state === "offline") test.setOnline(false);
      if (state === "hidden") test.setVisible(false);
      if (state === "asleep") test.sources[0].message({ kind: "power", state: "sleeping" });
      retryLiveEvents();
      expect(test.sources).toHaveLength(1);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });

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
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4&screens=off&window=1&frames=thread");
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
    expect(test.sources[1].url).toBe("/api/events?since=oldrun00%3A10&screens=off&window=1&frames=thread");

    test.sources[1].message({ kind: "hello", resumed: true, cursor: "oldrun00:13" });
    test.sources[1].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[2].url).toBe("/api/events?since=oldrun00%3A10&screens=off&window=1&frames=thread");

    test.sources[2].message({ kind: "hello", resumed: false, cursor: "newrun00:7" });
    test.sources[2].message({ kind: "message", value: "behind failed snapshot" }, "newrun00:8");
    snapshotResolutions.shift()?.(false);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(test.sources[3].url).toBe("/api/events?since=oldrun00%3A10&screens=off&window=1&frames=thread");

    test.sources[3].message({ kind: "hello", resumed: false, cursor: "newrun00:8" });
    test.sources[3].message({ kind: "message", value: "after snapshot" }, "newrun00:9");
    snapshotResolutions.shift()?.(true);
    await Promise.resolve();
    test.sources[3].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[4].url).toBe("/api/events?since=newrun00%3A9&screens=off&window=1&frames=thread");
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

describe("a Cloud home that goes to sleep", () => {
  it("closes the stream on its sleeping frame and stays closed, whatever the timers, until the person is back", () => {
    const test = harness();
    const onFrame = vi.fn(), onError = vi.fn();
    const stop = openLiveEvents({ onFrame, onError, onSnapshotRequired: async () => true, staleMs: 1_000, retryMinMs: 100, retryMaxMs: 100 }, test.platform);
    test.sources[0].open();
    test.sources[0].message({ kind: "message" }, "run00000:4");
    test.sources[0].message({ kind: "power", state: "sleeping" } as { kind: string });
    expect(cloudAsleep()).toBe(true);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenCalledOnce();
    test.setNow(60_000);
    vi.advanceTimersByTime(60_000);
    test.windowTarget.emit("focus");
    test.windowTarget.emit("online");
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(1);
    markCloudAwake();
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4&screens=off&window=1&frames=thread");
    stop();
  });

  it("wakes after its sleeping frame, so a Cloud that replays what follows a cursor never sends it back to sleep", async () => {
    // Such a Cloud: a resuming stream gets every frame after its cursor, the sleeping one included.
    const sent: { kind: string }[] = [];
    const serve = (source: FakeEventSource) => {
      const since = new URLSearchParams(source.url.split("?")[1]).get("since");
      const from = since === null ? null : Number(since.split(":")[1]);
      source.message({ kind: "hello", cursor: `run00000:${sent.length}`, resumed: from !== null });
      if (from !== null) sent.slice(from).forEach((frame, index) => source.message(frame, `run00000:${from + index + 1}`));
    };
    const send = (sources: FakeEventSource[], frame: { kind: string }) => {
      sent.push(frame);
      sources.at(-1)!.message(frame, `run00000:${sent.length}`);
    };
    const sleeping = { kind: "power", state: "sleeping" } as { kind: string };

    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents({ onFrame, onSnapshotRequired: async () => true }, test.platform);
    serve(test.sources[0]);
    await Promise.resolve();
    send(test.sources, { kind: "message" });
    send(test.sources, sleeping);
    expect(cloudAsleep()).toBe(true);
    markCloudAwake();
    serve(test.sources[1]);
    expect(cloudAsleep()).toBe(false);
    send(test.sources, { kind: "message", reply: "Here." } as { kind: string });
    expect(onFrame).toHaveBeenLastCalledWith({ kind: "message", reply: "Here." });
    stop();

    // A sleeping frame before the snapshot loaded: waking starts over with a new snapshot, never past the one it missed.
    const loading = harness();
    const stopLoading = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: () => new Promise<boolean>(() => {}) }, loading.platform);
    loading.sources[0].message({ kind: "hello", cursor: "run00000:3", resumed: false });
    loading.sources[0].message({ kind: "message" }, "run00000:4");
    loading.sources[0].message(sleeping, "run00000:5");
    expect(cloudAsleep()).toBe(true);
    markCloudAwake();
    expect(loading.sources[1].url).toBe("/api/events?screens=off&window=1&frames=thread");
    stopLoading();
  });

  it("ignores any other power frame", () => {
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].message({ kind: "power", state: "awake" } as { kind: string });
    expect(cloudAsleep()).toBe(false);
    expect(test.sources[0].close).not.toHaveBeenCalled();
    stop();
  });
});

describe("live screens", () => {
  it("leave screens out until a view that draws them listens, then reopen from the cursor both ways", async () => {
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    expect(test.sources[0].url).toBe("/api/events?screens=off&window=1&frames=thread");
    test.sources[0].open();
    test.sources[0].message({ kind: "hello", resumed: true, cursor: "run00000:3" });
    test.sources[0].message({ kind: "message" }, "run00000:4");

    const quiet = listenLiveFrames({ onFrame: () => {} });
    await Promise.resolve();
    expect(test.sources).toHaveLength(1);
    const viewer = listenLiveFrames({ screens: true, onFrame: () => {} });
    const second = listenLiveFrames({ screens: true, onFrame: () => {} });
    await Promise.resolve();
    expect(test.sources.map((source) => source.url)).toEqual(["/api/events?screens=off&window=1&frames=thread", "/api/events?since=run00000%3A4&window=1&frames=thread"]);
    expect(test.sources[0].close).toHaveBeenCalledOnce();

    viewer();
    await Promise.resolve();
    expect(test.sources).toHaveLength(2);
    second();
    await Promise.resolve();
    expect(test.sources[2].url).toBe("/api/events?since=run00000%3A4&screens=off&window=1&frames=thread");
    quiet();
    stop();
  });
});

describe("the live connection's phase, which the 30-second still-waiting event names", () => {
  it("is opening until the stream opens, open after, retrying once it is lost, offline while the computer is", () => {
    const test = harness();
    const stop = openLiveEvents({ onFrame: () => {}, onSnapshotRequired: async () => true }, test.platform);
    expect(livePhase()).toBe("opening");
    test.sources[0]!.open();
    expect(livePhase()).toBe("open");
    test.setOnline(false);
    test.sources[0]!.error();
    expect(livePhase()).toBe("offline");
    test.setOnline(true);
    test.windowTarget.emit("online");
    expect(livePhase()).toBe("opening");
    test.sources.at(-1)!.error();
    expect(livePhase()).toBe("retrying");
    stop();
  });
});

describe("the WebSocket feed", () => {
  function socketHarness() {
    const h = harness();
    const sockets: FakeEventSource[] = [];
    const platform = { ...h.platform, createWebSocket: (url: string) => {
      const socket = new FakeEventSource(url);
      sockets.push(socket);
      return socket;
    } };
    return { ...h, sockets, platform };
  }

  it("requires hello, bounds a silent upgrade and ignores its late callbacks", () => {
    const h = socketHarness();
    const onOpen = vi.fn();
    const onFrame = vi.fn();
    const stop = openLiveEvents({ onFrame, onOpen, onSnapshotRequired: async () => true }, h.platform);
    const socket = h.sockets[0]!;
    const late = socket.onmessage!;
    socket.message({ kind: "ping" });
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(h.sources).toHaveLength(0);
    late({ data: JSON.stringify({ kind: "message" }), lastEventId: "lost:2" });
    expect(onFrame).not.toHaveBeenCalled();
    stop();
  });

  it("reconnects repeatedly over WebSocket from the committed cursor", async () => {
    const h = socketHarness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, h.platform);
    h.sockets[0]!.message({ kind: "hello", cursor: "epoch:1", resumed: false });
    await Promise.resolve();
    h.sockets[0]!.message({ kind: "bot" }, "epoch:2");
    const error = h.sockets[0]!.onerror!;
    error(); error();
    vi.advanceTimersByTime(500);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]!.url).toContain("since=epoch%3A2");
    h.sockets[1]!.message({ kind: "hello", cursor: "epoch:2", resumed: true });
    h.sockets[1]!.error();
    expect(h.sources).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(h.sockets).toHaveLength(3);
    expect(h.sockets[2]!.url).toContain("since=epoch%3A2");
    expect(h.sources).toHaveLength(0);
    stop();
  });

  it("resumes the remaining hello budget after a hidden or offline interval", () => {
    const h = socketHarness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, { ...h.platform, now: Date.now });
    vi.advanceTimersByTime(2_000);
    h.setVisible(false);
    h.documentTarget.emit("visibilitychange");
    vi.advanceTimersByTime(60_000);
    h.setOnline(false);
    h.windowTarget.emit("offline");
    h.setVisible(true);
    h.documentTarget.emit("visibilitychange");
    vi.advanceTimersByTime(60_000);
    h.setOnline(true);
    h.windowTarget.emit("online");
    vi.advanceTimersByTime(999);
    expect(h.sockets).toHaveLength(1);
    expect(h.sources).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.sockets[0]!.close).toHaveBeenCalledOnce();
    expect(h.sources).toHaveLength(0);
    stop();
  });

  it("clears the handshake timer after hello and releases all timers on close", async () => {
    const h = socketHarness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, h.platform);
    expect(vi.getTimerCount()).toBe(2);
    h.sockets[0]!.message({ kind: "hello", cursor: "epoch:1", resumed: false });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps snapshot failure separate from transport failure", async () => {
    const h = socketHarness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => false }, h.platform);
    h.sockets[0]!.message({ kind: "hello", cursor: "epoch:1", resumed: false });
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(h.sockets).toHaveLength(2);
    expect(h.sources).toHaveLength(0);
    expect(h.sockets[1]!.url).not.toContain("since=");
    stop();
  });
  it("does not commit a snapshot that completes after socket loss", async () => {
    const h = socketHarness();
    let finish: (loaded: boolean) => void = () => {};
    const snapshot = new Promise<boolean>((resolve) => { finish = resolve; });
    const opened = vi.fn();
    const stop = openLiveEvents({ onFrame: vi.fn(), onOpen: opened, onSnapshotRequired: () => snapshot }, h.platform);
    h.sockets[0]!.open();
    expect(opened).not.toHaveBeenCalled();
    h.sockets[0]!.message({ kind: "hello", cursor: "epoch:4", resumed: false });
    h.sockets[0]!.message({ kind: "bot" }, "epoch:5");
    h.sockets[0]!.error();
    finish(true);
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(h.sockets[1]!.url).not.toContain("since=");
    stop();
  });

  it("retries WebSocket when construction fails", () => {
    const h = harness();
    const socket = vi.fn(() => { throw new Error("unsupported"); });
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, {
      ...h.platform, createWebSocket: socket,
    });
    vi.advanceTimersByTime(500);
    expect(socket).toHaveBeenCalledTimes(2);
    expect(h.sources).toHaveLength(0);
    stop();
  });

});

describe("browser transport selection", () => {
  function browser(search = "", desktop = false) {
    const sockets: FakeEventSource[] = [];
    const streams: FakeEventSource[] = [];
    vi.stubGlobal("window", Object.assign(new FakeTarget(), {
      location: new URL(`https://example.test/${search}`),
      ...(desktop ? { ogb: { platform: "linux" } } : {}),
    }));
    vi.stubGlobal("WebSocket", class extends FakeEventSource {
      constructor(url: URL) { super(url.href); sockets.push(this); }
    });
    vi.stubGlobal("EventSource", class extends FakeEventSource {
      constructor(url: string) { super(url); streams.push(this); }
    });
    const open = () => openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, {
      isVisible: () => true, isOnline: () => true, documentTarget: new FakeTarget(),
    });
    return { sockets, streams, open };
  }

  it.each(["", "?liveTransport=auto", "?liveTransport=sse"])("uses WebSocket for a direct browser at /%s", (search) => {
    const h = browser(search);
    const stop = h.open();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.url).toContain("wss://example.test/api/events?");
    expect(h.streams).toHaveLength(0);
    stop();
    expect(h.sockets[0]!.close).toHaveBeenCalledOnce();
  });

  it.each([
    { search: "", desktop: true },
    { search: "?liveTransport=auto", desktop: true },
  ])("keeps SSE for $search with desktop=$desktop", ({ search, desktop }) => {
    const h = browser(search, desktop);
    const stop = h.open();
    expect(h.sockets).toHaveLength(0);
    expect(h.streams).toHaveLength(1);
    stop();
  });

  it("keeps the relay link ahead of direct browser transports", () => {
    const h = browser();
    const fetch = vi.fn(async () => new Response("", { headers: { "content-type": "text/event-stream" } }));
    setRelayLink({ fetch, close: vi.fn() });
    const stop = h.open();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/events?"), expect.any(Object));
    expect(h.sockets).toHaveLength(0);
    expect(h.streams).toHaveLength(0);
    stop();
  });
});
