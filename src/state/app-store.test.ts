import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore, nextPaint, type FrameSchedule } from "./app-store";

type Action = { type: "frame" | "action"; id: string };

function fixture() {
  const scheduled: Array<() => void> = [];
  const schedule: FrameSchedule = (flush) => {
    scheduled.push(flush);
    return () => { scheduled.splice(scheduled.indexOf(flush), 1); };
  };
  const store = createAppStore<string[], Action, string>((state, action) => [...state, `${action.type}:${action.id}`], [], schedule);
  const notified = vi.fn();
  store.subscribe(notified);
  const handled: string[] = [];
  const stop = store.handleFrames((frame) => {
    handled.push(frame);
    store.dispatch({ type: "frame", id: frame });
  });
  const paint = () => { for (const flush of scheduled.splice(0)) flush(); };
  return { store, notified, handled, stop, paint, scheduled };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("live frames reach the store once per paint", () => {
  it("applies every queued frame in arrival order at the next paint, as one change", () => {
    const { store, notified, paint, scheduled } = fixture();
    store.enqueueFrame("a");
    store.enqueueFrame("b");
    store.enqueueFrame("c");
    expect(store.getState()).toEqual([]);
    expect(scheduled).toHaveLength(1);
    paint();
    expect(store.getState()).toEqual(["frame:a", "frame:b", "frame:c"]);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("applies queued frames before an action that arrives after them", () => {
    const { store, notified, scheduled } = fixture();
    store.enqueueFrame("a");
    store.enqueueFrame("b");
    store.dispatch({ type: "action", id: "1" });
    expect(store.getState()).toEqual(["frame:a", "frame:b", "action:1"]);
    expect(scheduled, "the paint it waited for is cancelled").toHaveLength(0);
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("flushes on demand, so a reader sees every frame that came before it", () => {
    const { store, paint } = fixture();
    store.enqueueFrame("a");
    store.flushFrames();
    expect(store.getState()).toEqual(["frame:a"]);
    paint();
    expect(store.getState()).toEqual(["frame:a"]);
  });

  it("applies an urgent frame now, after the frames queued before it", () => {
    const { store, notified, scheduled } = fixture();
    store.enqueueFrame("a");
    store.enqueueFrame("call", true);
    expect(store.getState()).toEqual(["frame:a", "frame:call"]);
    expect(scheduled).toHaveLength(0);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("keeps applying the frames after one that throws", async () => {
    const thrown: unknown[] = [];
    const store = createAppStore<string[], string, string>((state, action) => [...state, action], [], (flush) => { flush(); return () => {}; });
    store.handleFrames((frame) => {
      if (frame === "bad") throw new Error("bad frame");
      store.dispatch(frame);
    });
    const onError = (error: unknown) => { thrown.push(error); };
    process.on("uncaughtException", onError);
    try {
      store.enqueueFrame("bad");
      store.enqueueFrame("good");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("uncaughtException", onError);
    }
    expect(store.getState()).toEqual(["good"]);
    expect(thrown).toEqual([new Error("bad frame")]);
  });

  it("does not tell subscribers about a frame that changed nothing", () => {
    const store = createAppStore<number, number, number>((state, action) => Math.max(state, action), 5, (flush) => { flush(); return () => {}; });
    const notified = vi.fn();
    store.subscribe(notified);
    store.handleFrames((frame) => store.dispatch(frame));
    store.enqueueFrame(3);
    expect(notified).not.toHaveBeenCalled();
    store.enqueueFrame(7);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("drops the queue once its handler stops", () => {
    const { store, stop, paint, scheduled } = fixture();
    store.enqueueFrame("a");
    stop();
    expect(scheduled).toHaveLength(0);
    paint();
    store.dispatch({ type: "action", id: "1" });
    expect(store.getState()).toEqual(["action:1"]);
  });
});

describe("the next paint", () => {
  it("is the next animation frame while the window shows", () => {
    vi.useFakeTimers();
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
    const flush = vi.fn();
    nextPaint(flush);
    frame!(0);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(flush, "the fallback timer is cleared").toHaveBeenCalledTimes(1);
  });

  it("falls back to a timer when no animation frame comes, as in a hidden window", () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => 7);
    vi.stubGlobal("cancelAnimationFrame", cancelled);
    const flush = vi.fn();
    nextPaint(flush);
    vi.advanceTimersByTime(99);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledWith(7);
  });

  it("can be cancelled", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flush = vi.fn();
    nextPaint(flush)();
    vi.advanceTimersByTime(1_000);
    expect(flush).not.toHaveBeenCalled();
  });
});
