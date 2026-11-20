// Runs against a small stand-in for React's hooks (no DOM) and a scroller whose height is its mounted row count.
import type { DependencyList } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const react = vi.hoisted(() => {
  type Committed = { deps?: DependencyList; cleanup?: void | (() => void) };
  type Pending = { slot: number; layout: boolean; deps?: DependencyList; run: () => void | (() => void) };
  const runtime = { slots: [] as unknown[], cursor: 0, dirty: false, pending: [] as Pending[] };
  const same = (a?: DependencyList, b?: DependencyList) =>
    Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: DependencyList) => {
    const slot = runtime.cursor++;
    if (same((runtime.slots[slot] as Committed | undefined)?.deps, deps)) return;
    runtime.pending.push({ slot, layout, deps, run });
  };
  const memo = <T,>(factory: () => T, deps: DependencyList): T => {
    const slot = runtime.cursor++;
    const held = runtime.slots[slot] as { value: T; deps: DependencyList } | undefined;
    if (held && same(held.deps, deps)) return held.value;
    const value = factory();
    runtime.slots[slot] = { value, deps };
    return value;
  };
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const slot = runtime.cursor++;
      if (!runtime.slots[slot]) {
        const cell = {
          value: typeof initial === "function" ? (initial as () => T)() : initial,
          set: (next: T | ((current: T) => T)) => {
            const value = typeof next === "function" ? (next as (current: T) => T)(cell.value) : next;
            if (Object.is(value, cell.value)) return;
            cell.value = value;
            runtime.dirty = true;
          },
        };
        runtime.slots[slot] = cell;
      }
      const cell = runtime.slots[slot] as { value: T; set: (next: T | ((current: T) => T)) => void };
      return [cell.value, cell.set] as const;
    },
    useRef<T>(initial: T) {
      const slot = runtime.cursor++;
      return (runtime.slots[slot] ??= { current: initial }) as { current: T };
    },
    useMemo: memo,
    useCallback: <T,>(callback: T, deps: DependencyList) => memo(() => callback, deps),
    useEffect: effect(false),
    useLayoutEffect: effect(true),
  };
  /** A render-phase update re-renders before committing, as React does; layout effects run before passive ones. */
  function render(draw: () => void, commit: () => void) {
    for (let pass = 0; pass < 20; pass++) {
      runtime.cursor = 0;
      runtime.dirty = false;
      runtime.pending = [];
      draw();
      if (runtime.dirty) continue;
      commit();
      const pending = [...runtime.pending.filter((e) => e.layout), ...runtime.pending.filter((e) => !e.layout)];
      for (const { slot, deps, run } of pending) {
        (runtime.slots[slot] as Committed | undefined)?.cleanup?.();
        runtime.slots[slot] = { deps, cleanup: run() };
      }
      if (!runtime.dirty) return;
    }
    throw new Error("render did not settle");
  }
  return { runtime, hooks, render };
});
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...react.hooks }));

const store = vi.hoisted(() => ({
  state: {
    focusMessage: null as null | { threadId: string; messageId: string; nonce: number; consumed: boolean },
    loadingOlder: {} as Record<string, true>,
  },
  dispatch: (() => {}) as (action: unknown) => void,
}));
vi.mock("@/state/store-select", async (importOriginal) => (await import("@/testing/plain-store-select")).plainStoreSelect(await importOriginal()));
vi.mock("@/state/store", () => ({ useStore: () => store }));
// Scrolling a hit into view needs the real DOM; this suite checks the window around it.
vi.mock("@/lib/focus-message", () => ({ useFocusMessage: () => {} }));

import { useTranscriptViewport } from "./use-transcript-viewport";
import { TRANSCRIPT_WINDOW_MAX, TRANSCRIPT_WINDOW_STEP } from "@/lib/transcript-window";
import { forgetTranscriptPositions } from "@/lib/transcript-follow";
import { noteLiveReplyEvent, resetLiveReplies } from "@/state/live-reply";
import type { RuntimeEvent } from "../../shared/runtime-events";

type Row = { id: string; role?: "user" | "bot" };
const rows = (count: number, from = 0): Row[] => Array.from({ length: count }, (_, index) => ({ id: `m${from + index}` }));

const ROW = 50;
class Scroller {
  rows = 0;
  extra = 0;
  scrollTop = 0;
  clientHeight = 400;
  clientWidth = 400;
  calls: ScrollToOptions[] = [];
  get scrollHeight() {
    return this.rows * ROW + this.extra;
  }
  get bottom() {
    return Math.max(0, this.scrollHeight - this.clientHeight);
  }
  scrollTo(options: ScrollToOptions) {
    this.calls.push(options);
    this.scrollTop = Math.max(0, Math.min(options.top ?? this.scrollTop, this.bottom));
  }
  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight, height: this.clientHeight };
  }
}

/** The mounted rows, each ROW tall, laid out from the scroller's top. */
const transcriptOf = (shown: readonly Row[]) => ({
  querySelectorAll: () => shown.map((row, index) => {
    const top = index * ROW - scroller.scrollTop;
    return { dataset: { mid: row.id }, getBoundingClientRect: () => ({ top, bottom: top + ROW, height: ROW }) };
  }),
});

type Props = Parameters<typeof useTranscriptViewport<Row>>[0];
let scroller: Scroller;
let frames: FrameRequestCallback[];
let keyListeners: Set<(event: Partial<KeyboardEvent>) => void>;
let observers: number;
let resized: (() => void)[];
let dispatched: unknown[];

function mount(initial: Partial<Props> = {}) {
  let props: Props = { ownerId: "bot", threadId: "thread", messages: rows(10), pinOn: [false], ...initial };
  let result!: ReturnType<typeof useTranscriptViewport<Row>>;
  const draw = () => {
    result = useTranscriptViewport(props);
  };
  // React's commit before layout effects; a browser clamps scrollTop when content gets shorter.
  const commit = () => {
    result.scrollRef.current = scroller as unknown as HTMLDivElement;
    result.transcriptRef.current = transcriptOf(result.windowedMessages) as unknown as HTMLDivElement;
    scroller.rows = result.windowedMessages.length;
    scroller.scrollTop = Math.min(scroller.scrollTop, scroller.bottom);
  };
  const flushFrames = () => {
    const queued = frames;
    frames = [];
    for (const frame of queued) frame(0);
  };
  react.render(draw, commit);
  return {
    get current() {
      return result;
    },
    rerender(next: Partial<Props>) {
      props = { ...props, ...next };
      react.render(draw, commit);
    },
    act(handler: () => void) {
      handler();
      react.render(draw, commit);
      flushFrames();
    },
    unmount,
  };
}

/** Runs every committed effect's cleanup, as an unmount does. */
function unmount() {
  for (const slot of react.runtime.slots) {
    const cleanup = (slot as { cleanup?: unknown } | undefined)?.cleanup;
    if (typeof cleanup === "function") cleanup();
  }
  react.runtime.slots = [];
}

beforeEach(() => {
  react.runtime.slots = [];
  scroller = new Scroller();
  frames = [];
  keyListeners = new Set();
  observers = 0;
  resized = [];
  dispatched = [];
  forgetTranscriptPositions();
  resetLiveReplies();
  store.state.focusMessage = null;
  store.state.loadingOlder = {};
  store.dispatch = (action) => dispatched.push(action);
  vi.stubGlobal("window", {
    addEventListener: (_: string, listener: (event: Partial<KeyboardEvent>) => void) => keyListeners.add(listener),
    removeEventListener: (_: string, listener: (event: Partial<KeyboardEvent>) => void) => keyListeners.delete(listener),
  });
  const requested: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => { frames.push(frame); return requested.push(frame); });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames = frames.filter((frame) => frame !== requested[id - 1]); });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) {
      observers++;
      resized.push(callback);
    }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor() {}
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLInputElement", class {});
  return () => {
    unmount();
    vi.unstubAllGlobals();
  };
});

const press = (key: string, target: unknown = {}) => {
  for (const listener of keyListeners) listener({ key, target } as unknown as KeyboardEvent);
};

describe("transcript viewport", () => {
  it("follows new rows to the bottom until the reader scrolls up", () => {
    const view = mount({ messages: rows(10) });
    expect(view.current.following).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);

    view.rerender({ messages: rows(11) });
    expect(scroller.scrollTop).toBe(11 * ROW - 400);

    scroller.extra = 80;
    view.rerender({ pinOn: [true] });
    expect(scroller.scrollTop).toBe(11 * ROW + 80 - 400);

    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    expect(view.current.following).toBe(false);
    const reading = scroller.scrollTop;
    view.rerender({ messages: rows(12) });
    expect(scroller.scrollTop).toBe(reading);
  });

  it("treats scrollbar grabs, scroll keys and a dragging finger as leaving the bottom", () => {
    const view = mount({ messages: rows(30) });
    view.act(() =>
      view.current.scrollHandlers.onPointerDown({ target: scroller, nativeEvent: { offsetX: 404 } } as never),
    );
    expect(view.current.following).toBe(false);

    view.act(() => {
      scroller.scrollTop = 200;
      view.current.scrollHandlers.onScroll();
    });
    expect(view.current.following).toBe(false);
    view.act(() => {
      scroller.scrollTop = scroller.bottom;
      view.current.scrollHandlers.onScroll();
    });
    expect(view.current.following).toBe(true);

    view.act(() => press("ArrowUp", new HTMLTextAreaElement()));
    expect(view.current.following).toBe(true);
    view.act(() => press("PageUp"));
    expect(view.current.following).toBe(false);

    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: 30 } as never));
    expect(view.current.following).toBe(true);
    view.act(() => view.current.scrollHandlers.onTouchStart({ touches: [{ clientY: 100 }] } as never));
    view.act(() => view.current.scrollHandlers.onTouchMove({ touches: [{ clientY: 110 }] } as never));
    expect(view.current.following).toBe(false);
  });

  it("mounts only the last window of a long thread and re-tails it when another thread opens", () => {
    const view = mount({ messages: rows(300) });
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.hiddenCount).toBe(180);

    view.act(() => view.current.showEarlier());
    expect(view.current.hiddenCount).toBe(180 - TRANSCRIPT_WINDOW_STEP);

    view.rerender({ threadId: "other", messages: [{ id: "ask", role: "user" }, ...rows(299, 1_001)] });
    expect(view.current.transcriptKey).toBe("bot:other");
    expect(view.current.hiddenCount).toBe(180);
    expect(view.current.windowedMessages[0]?.id).toBe("m1180");
  });

  it("keeps the open card work rests on drawn however many rows follow it", () => {
    const rests = (row: Row) => row.id === "card";
    const thread = [...rows(5), { id: "card" }, ...rows(200, 5)];
    const view = mount({ messages: thread, rests });
    expect(view.current.hiddenCount).toBe(thread.length - 120);
    expect(view.current.windowedMessages[0]?.id).toBe("card");
    expect(view.current.windowedMessages.slice(1)).toEqual(thread.slice(-120));

    view.rerender({ messages: thread, rests: () => false });
    expect(view.current.windowedMessages).toEqual(thread.slice(-120));
  });

  it("keeps the window bounded while the reader follows new rows", () => {
    const view = mount({ messages: rows(300) });
    for (let total = 301; total <= 900; total++) {
      view.rerender({ messages: rows(total) });
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(120);
      expect(scroller.scrollTop).toBe(scroller.bottom);
    }
    expect(view.current.windowedMessages[0]?.id).toBe("m780");
    expect(view.current.windowedMessages.at(-1)?.id).toBe("m899");
    expect(view.current.hiddenCount).toBe(780);
  });

  it("keeps the person's newest message mounted while a long turn follows it", () => {
    let thread: Row[] = [...rows(30), { id: "ask", role: "user" }];
    const view = mount({ messages: thread });
    for (let step = 0; step < 150; step++) {
      thread = [...thread, { id: `step${step}`, role: "bot" }];
      view.rerender({ messages: thread });
      expect(view.current.windowedMessages.map((row) => row.id)).toContain("ask");
      expect(scroller.scrollTop).toBe(scroller.bottom);
    }
    expect(view.current.windowedMessages[0]?.id).toBe("ask");
    expect(view.current.windowedMessages).toHaveLength(151);

    view.rerender({ messages: [...thread, { id: "ask2", role: "user" }] });
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.windowedMessages.at(-1)?.id).toBe("ask2");
  });

  it("keeps the person's newest message mounted when many steps arrive at once", () => {
    const asked: Row[] = [...rows(30), { id: "ask", role: "user" }];
    const view = mount({ messages: asked });
    view.rerender({ messages: [...asked, ...rows(150, 100)] });
    expect(view.current.windowedMessages[0]?.id).toBe("ask");
    expect(scroller.scrollTop).toBe(scroller.bottom);
  });

  it("keeps the window to two windows while one long stretch follows a single message", () => {
    let thread: Row[] = [{ id: "ask", role: "user" }];
    const view = mount({ messages: thread });
    for (let step = 0; step < 600; step++) {
      thread = [...thread, { id: `step${step}`, role: "bot" }];
      view.rerender({ messages: thread });
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(2 * 120);
      expect(view.current.following).toBe(true);
      expect(scroller.scrollTop).toBe(scroller.bottom);
      if (thread.length <= 2 * 120) expect(view.current.windowedMessages[0]?.id).toBe("ask");
    }
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.windowedMessages.at(-1)?.id).toBe("step599");
  });

  it("does not hold for a message that is already above the window", () => {
    let thread: Row[] = [...rows(30), { id: "ask", role: "user" }, ...rows(200, 1_000)];
    const view = mount({ messages: thread });
    expect(view.current.hiddenCount).toBe(111);
    for (let step = 0; step < 300; step++) {
      thread = [...thread, { id: `step${step}`, role: "bot" }];
      view.rerender({ messages: thread });
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(120);
      expect(scroller.scrollTop).toBe(scroller.bottom);
    }
    expect(view.current.windowedMessages.at(-1)?.id).toBe("step299");
  });

  it("holds the reader's rows once they have scrolled away, drawing new rows only up to the window's cap", () => {
    const view = mount({ messages: rows(300) });
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    scroller.scrollTop = 2_000;
    for (let total = 301; total <= 900; total++) view.rerender({ messages: rows(total) });
    expect(view.current.hiddenCount).toBe(180);
    expect(view.current.windowedMessages).toHaveLength(TRANSCRIPT_WINDOW_MAX);
    expect(view.current.laterCount).toBe(900 - 180 - TRANSCRIPT_WINDOW_MAX);
    expect(scroller.scrollTop).toBe(2_000);
  });

  it("slides back to the latest window when the reader returns to the bottom", () => {
    const view = mount({ messages: rows(300) });
    while (view.current.windowedMessages.length < TRANSCRIPT_WINDOW_MAX) view.act(() => view.current.showEarlier());
    view.act(() => {
      scroller.scrollTop = 1_000;
      view.current.scrollHandlers.onScroll();
    });
    view.rerender({ messages: rows(301) });
    expect(view.current.hiddenCount).toBe(60);
    expect(view.current.laterCount, "the row past the cap waits below a reader up the page").toBe(1);

    view.act(() => {
      scroller.scrollTop = scroller.bottom;
      view.current.scrollHandlers.onScroll();
      view.current.scrollHandlers.onWheel({ deltaY: 40 } as never);
    });
    expect(view.current.following, "the bottom of a window short of the newest row is not the end").toBe(false);
    expect(view.current.laterCount).toBe(0);
    view.act(() => {
      scroller.scrollTop = scroller.bottom;
      view.current.scrollHandlers.onScroll();
    });
    expect(view.current.following).toBe(true);
    expect(view.current.hiddenCount).toBe(181);
    expect(scroller.scrollTop).toBe(scroller.bottom);
  });

  it("lets the oldest rows go instead when rows arrive under a reader near the bottom", () => {
    let thread = rows(300);
    const view = mount({ messages: thread });
    view.act(() => view.current.showEarlier());
    view.act(() => {
      scroller.scrollTop = scroller.bottom - 200;
      view.current.scrollHandlers.onScroll();
    });
    expect(view.current.following).toBe(false);
    for (let step = 0; step < 300; step++) {
      scroller.scrollTop = Math.max(0, scroller.bottom - 200);
      const reading = view.current.windowedMessages[Math.floor(scroller.scrollTop / ROW)]!.id;
      thread = [...thread, { id: `new${step}`, role: "bot" }];
      view.rerender({ messages: thread });
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
      expect(view.current.laterCount).toBe(0);
      expect(view.current.windowedMessages[Math.floor(scroller.scrollTop / ROW)]!.id).toBe(reading);
    }
    expect(view.current.windowedMessages.at(-1)?.id).toBe("new299");
  });

  it("shows the tail of a thread that shrinks under the window, following or not", () => {
    const view = mount({ messages: rows(300) });
    view.rerender({ messages: rows(400) });
    view.rerender({ messages: rows(150) });
    expect(view.current.hiddenCount).toBe(30);
    expect(view.current.windowedMessages).toHaveLength(120);

    view.act(() => press("PageUp"));
    view.rerender({ messages: rows(20) });
    expect(view.current.hiddenCount).toBe(0);
    expect(view.current.windowedMessages).toHaveLength(20);
  });

  it("re-tails a following window when the thread shrinks but still reaches past its start", () => {
    const view = mount({ messages: rows(300) });
    view.rerender({ messages: rows(620) });
    expect(view.current.hiddenCount).toBe(500);

    const branch: Row[] = [...rows(450), { id: "ask", role: "user" }, ...rows(109, 2_000)];
    view.rerender({ messages: branch });
    expect(view.current.hiddenCount).toBe(440);
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.windowedMessages.map((row) => row.id)).toContain("ask");
    expect(scroller.scrollTop).toBe(scroller.bottom);

    view.act(() => press("PageUp"));
    view.rerender({ messages: rows(500) });
    expect(view.current.hiddenCount).toBe(440);
  });

  it("shows earlier rows without moving the row under the reader", () => {
    const view = mount({ messages: rows(300) });
    scroller.scrollTop = 1_000;
    view.act(() => view.current.showEarlier());
    expect(view.current.windowedMessages[0]?.id).toBe(`m${180 - TRANSCRIPT_WINDOW_STEP}`);
    expect(scroller.scrollTop).toBe(1_000 + TRANSCRIPT_WINDOW_STEP * ROW);
    expect(view.current.following).toBe(false);
  });

  it("keeps the reader's row in place when an older page arrives from the server", () => {
    const view = mount({ messages: rows(50, 100) });
    scroller.scrollTop = 300;
    view.act(() => view.current.loadOlder());
    expect(dispatched).toEqual([{ type: "loadOlderMessages", threadId: "thread" }]);
    expect(view.current.following).toBe(false);

    store.state.loadingOlder = { thread: true };
    view.rerender({});
    expect(view.current.olderPending).toBe(true);

    store.state.loadingOlder = {};
    view.rerender({ messages: [...rows(50, 50), ...rows(50, 100)] });
    expect(view.current.olderPending).toBe(false);
    expect(scroller.scrollTop).toBe(300 + TRANSCRIPT_WINDOW_STEP * ROW);
  });

  it("drops a height capture taken in the thread the reader left", () => {
    const view = mount({ messages: rows(50, 100) });
    scroller.scrollTop = 300;
    view.act(() => view.current.loadOlder());
    view.rerender({ threadId: "other", messages: rows(80, 500) });
    expect(view.current.following).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);
    expect(scroller.scrollTop).not.toBe(300);
  });

  it("drops the capture on a switch even when the next thread opens on the same first row", () => {
    const view = mount({ messages: rows(50, 100) });
    scroller.scrollTop = 300;
    view.act(() => view.current.loadOlder());
    view.rerender({ threadId: "other" });
    expect(scroller.scrollTop).toBe(scroller.bottom);
    expect(view.current.following).toBe(true);
    view.rerender({ threadId: "thread", messages: [...rows(50, 50), ...rows(50, 100)] });
    expect(view.current.following).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);
  });

  it("opens a bounded window around a search result and pages forward from it", () => {
    store.state.focusMessage = { threadId: "thread", messageId: "m10", nonce: 1, consumed: false };
    const view = mount({ messages: rows(300) });
    expect(view.current.windowedMessages.map((row) => row.id)).toContain("m10");
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.laterCount).toBe(180);
    expect(view.current.following).toBe(false);

    view.act(() => view.current.showLater());
    expect(view.current.laterCount).toBe(180 - TRANSCRIPT_WINDOW_STEP);
  });

  it("pages on past a search result as the reader scrolls down, and follows only from the newest row", () => {
    store.state.focusMessage = { threadId: "thread", messageId: "m10", nonce: 1, consumed: false };
    const view = mount({ messages: rows(300) });
    view.act(() => {
      scroller.scrollTop = scroller.bottom;
      view.current.scrollHandlers.onScroll();
    });
    expect(view.current.following).toBe(false);
    expect(view.current.windowedMessages[0]?.id).toBe("m0");
    expect(view.current.laterCount).toBe(180 - TRANSCRIPT_WINDOW_STEP);
    view.rerender({ messages: rows(301) });
    expect(view.current.laterCount).toBe(181 - TRANSCRIPT_WINDOW_STEP);
    expect(view.current.showJumpToLatest || view.current.following).toBe(false);
  });

  it("jumps back to the latest rows and resumes following", () => {
    const view = mount({ messages: rows(300) });
    view.act(() => view.current.showEarlier());
    expect(view.current.following).toBe(false);

    view.act(() => view.current.jumpToLatest());
    expect(view.current.following).toBe(true);
    expect(view.current.hiddenCount).toBe(180);
    expect(scroller.calls.at(-1)).toEqual({ top: 120 * ROW, behavior: "smooth" });
  });

  it("jumps without the smooth animation when motion is reduced", () => {
    const view = mount({ messages: rows(300) });
    view.act(() => view.current.showEarlier());
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }),
    });
    view.act(() => view.current.jumpToLatest());
    expect(view.current.following).toBe(true);
    expect(scroller.calls.at(-1)).toEqual({ top: 120 * ROW, behavior: "auto" });
  });

  it("keeps following a transcript too short to scroll, so Jump to latest never shows over nothing", () => {
    const view = mount({ messages: rows(4) });
    expect(scroller.scrollHeight).toBeLessThan(scroller.clientHeight);
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    view.act(() => press("PageUp"));
    view.act(() => press("ArrowUp"));
    view.act(() => view.current.scrollHandlers.onTouchStart({ touches: [{ clientY: 100 }] } as never));
    view.act(() => view.current.scrollHandlers.onTouchMove({ touches: [{ clientY: 200 }] } as never));
    expect(view.current.following).toBe(true);
  });

  it("reveals earlier rows on an upward scroll when the shown rows are too short to scroll (#4365)", () => {
    // Hidden tool steps can leave a whole window shorter than the screen: no scrollbar, so no scroll events.
    scroller.clientHeight = 20_000;
    const view = mount({ messages: rows(300) });
    expect(view.current.hiddenCount).toBe(180);
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    expect(view.current.hiddenCount).toBe(180 - TRANSCRIPT_WINDOW_STEP);
    view.act(() => view.current.scrollHandlers.onTouchStart({ touches: [{ clientY: 100 }] } as never));
    view.act(() => view.current.scrollHandlers.onTouchMove({ touches: [{ clientY: 200 }] } as never));
    expect(view.current.hiddenCount).toBe(180 - 2 * TRANSCRIPT_WINDOW_STEP);
  });

  it("loads an older page on an upward scroll when the whole thread so far is too short to scroll (#4365)", () => {
    scroller.clientHeight = 10_000;
    const view = mount({ messages: rows(50), hasMore: true });
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    expect(dispatched).toEqual([{ type: "loadOlderMessages", threadId: "thread" }]);
  });

  it("keeps following when arrow keys move through a menu or list", () => {
    const view = mount({ messages: rows(30) });
    const inMenu = { closest: (selector: string) => (selector.includes('[role="menu"]') ? {} : null) };
    view.act(() => press("ArrowUp", inMenu));
    view.act(() => press("Home", inMenu));
    view.act(() => press("PageUp", inMenu));
    expect(view.current.following).toBe(true);
    view.act(() => press("ArrowUp", { closest: () => null }));
    expect(view.current.following).toBe(false);
  });

  it("re-arms following when another bot or room opens", () => {
    const view = mount({ messages: rows(30) });
    view.act(() => press("PageUp"));
    expect(view.current.following).toBe(false);
    view.rerender({ ownerId: "other-bot", threadId: "other", messages: rows(30, 100) });
    expect(view.current.following).toBe(true);
  });

  it("re-arms following when the same bot opens another thread", () => {
    const view = mount({ messages: rows(30) });
    view.act(() => press("PageUp"));
    scroller.scrollTop = 200;
    scroller.calls = [];
    expect(view.current.following).toBe(false);
    view.rerender({ threadId: "other", messages: rows(30, 100) });
    expect(view.current.transcriptKey).toBe("bot:other");
    expect(view.current.following).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);
    expect(scroller.calls).toHaveLength(1);
  });

  it("still stops following when a search jump lands in the thread just opened", () => {
    const view = mount({ messages: rows(300) });
    view.act(() => press("PageUp"));
    scroller.calls = [];
    store.state.focusMessage = { threadId: "other", messageId: "m10", nonce: 1, consumed: false };
    view.rerender({ threadId: "other", messages: rows(300) });
    expect(view.current.following).toBe(false);
    expect(view.current.windowedMessages.map((row) => row.id)).toContain("m10");
    expect(scroller.calls).toHaveLength(0);
  });

  it("watches the transcript for growth only while it is on screen", () => {
    const view = mount({ messages: rows(10), transcriptShown: false });
    expect(observers).toBe(0);
    view.rerender({ transcriptShown: true });
    expect(observers).toBe(1);
  });

  it("automatically expands earlier windowed messages when user scrolls near the top", () => {
    const view = mount({ messages: rows(300) });
    expect(view.current.hiddenCount).toBe(180);

    view.act(() => {
      scroller.scrollTop = 200;
      view.current.scrollHandlers.onWheel({ deltaY: -40 } as never);
      view.current.scrollHandlers.onScroll();
    });

    expect(view.current.hiddenCount).toBe(180 - TRANSCRIPT_WINDOW_STEP);
  });

  it("automatically loads older messages from server when at top of window and hasMore is true", () => {
    const view = mount({ messages: rows(50), hasMore: true });
    expect(view.current.hiddenCount).toBe(0);

    view.act(() => {
      scroller.scrollTop = 150;
      view.current.scrollHandlers.onWheel({ deltaY: -40 } as never);
      view.current.scrollHandlers.onScroll();
    });

    expect(dispatched).toEqual([{ type: "loadOlderMessages", threadId: "thread" }]);
  });
});

describe("a long conversation read from its end to its start and back", () => {
  const topId = (view: ReturnType<typeof mount>) => view.current.windowedMessages[Math.floor(scroller.scrollTop / ROW)]!.id;
  const scrollTo = (view: ReturnType<typeof mount>, top: number) => view.act(() => {
    scroller.scrollTop = top;
    view.current.scrollHandlers.onScroll();
  });
  /** Scrolls to `top` and returns the row the reader sees there, read before the window steps. */
  const readAt = (view: ReturnType<typeof mount>, top: number) => {
    scroller.scrollTop = top;
    const reading = topId(view);
    view.act(() => view.current.scrollHandlers.onScroll());
    return reading;
  };

  it("draws a bounded window all the way up and down, with the row under the reader held in place at each step", () => {
    const view = mount({ messages: rows(3_000) });
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    let steps = 0;
    while (view.current.hiddenCount > 0 && steps++ < 200) {
      scrollTo(view, 400);
      const reading = readAt(view, 200);
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
      expect(topId(view), "the row at the top stays the row at the top").toBe(reading);
    }
    expect(view.current.windowedMessages[0]?.id).toBe("m0");
    expect(view.current.windowedMessages).toHaveLength(TRANSCRIPT_WINDOW_MAX);
    expect(view.current.laterCount).toBe(3_000 - TRANSCRIPT_WINDOW_MAX);
    expect(view.current.following).toBe(false);

    steps = 0;
    while (view.current.laterCount > 0 && steps++ < 200) {
      scrollTo(view, scroller.bottom - 800);
      const reading = readAt(view, scroller.bottom - 100);
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
      expect(topId(view), "the row at the top stays the row at the top").toBe(reading);
      expect(view.current.following, "no follow before the newest row").toBe(false);
    }
    expect(view.current.windowedMessages.at(-1)?.id).toBe("m2999");
    scrollTo(view, scroller.bottom);
    expect(view.current.following).toBe(true);
    expect(view.current.windowedMessages).toHaveLength(120);
  });

  it("keeps a window of held pages bounded as older pages arrive from the server", () => {
    let held = rows(200, 2_800);
    const view = mount({ messages: held, hasMore: true });
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    for (let page = 13; page >= 0; page--) {
      while (view.current.hiddenCount > 0) {
        scrollTo(view, 900);
        scrollTo(view, 100);
      }
      dispatched = [];
      scrollTo(view, 900);
      scrollTo(view, 100);
      expect(dispatched).toEqual([{ type: "loadOlderMessages", threadId: "thread" }]);
      const reading = topId(view);
      held = [...rows(200, page * 200), ...held];
      view.rerender({ messages: held, hasMore: page > 0 });
      expect(topId(view), "the row at the top stays the row at the top").toBe(reading);
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
    }
    expect(held).toHaveLength(3_000);
  });

  it("lets go of the rows paged in above the window when the reader leaves", () => {
    const view = mount({ messages: rows(3_000) });
    view.act(() => view.current.showEarlier());
    const windowFirst = view.current.windowedMessages[0]!.id;
    dispatched = [];
    view.rerender({ threadId: "other", messages: rows(10, 9_000) });
    expect(dispatched).toEqual([{ type: "trimHeldMessages", threadId: "thread", keepFromId: windowFirst }]);
  });
});

describe("following a reply and coming back to a conversation", () => {
  const readUpTo = (view: ReturnType<typeof mount>, scrollTop: number) => {
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    view.act(() => {
      scroller.scrollTop = scrollTop;
      view.current.scrollHandlers.onScroll();
    });
  };

  it("opens a conversation where the reader left it, and another one at its end", () => {
    const view = mount({ messages: rows(300) });
    readUpTo(view, 1_000);
    expect(view.current.following).toBe(false);
    const reading = view.current.windowedMessages[1_000 / ROW]!.id;

    view.rerender({ threadId: "other", messages: rows(50, 5_000) });
    expect(view.current.following, "a conversation never read opens at its end").toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);

    scroller.calls = [];
    view.rerender({ threadId: "thread", messages: rows(300) });
    expect(view.current.following).toBe(false);
    expect(view.current.windowedMessages.map((row) => row.id)).toContain(reading);
    expect(view.current.windowedMessages[scroller.scrollTop / ROW]!.id, "the same row is at the top, before any paint").toBe(reading);
    expect(scroller.calls, "no trip to the end on the way").toEqual([]);
    expect(view.current.showJumpToLatest).toBe(false);
  });

  it("opens at the end a conversation the reader left following, even after it grew", () => {
    const view = mount({ messages: rows(40) });
    view.rerender({ threadId: "other", messages: rows(40, 5_000) });
    readUpTo(view, 200);
    view.rerender({ threadId: "thread", messages: rows(60) });
    expect(view.current.following).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);
  });

  it("follows the end again when the person sends a message, wherever they were reading", () => {
    const view = mount({ messages: rows(60) });
    readUpTo(view, 300);
    expect(view.current.following).toBe(false);
    view.rerender({ messages: [...rows(60), { id: "optimistic-1", role: "user" }] });
    expect(view.current.following).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);
  });

  it("does not follow a message someone else sent while the reader is up the page", () => {
    const view = mount({ messages: rows(60) });
    readUpTo(view, 300);
    view.rerender({ messages: [...rows(60), { id: "from-a-teammate", role: "user" }] });
    expect(view.current.following).toBe(false);
    expect(scroller.scrollTop).toBe(300);
  });

  it("glides after a growing reply while following, lands at once otherwise, and never pulls a reader down", () => {
    const view = mount({ messages: rows(20) });
    const grow = () => {
      scroller.extra += 30;
      for (const callback of resized) callback();
    };
    grow();
    expect(scroller.calls.at(-1)).toEqual({ top: scroller.scrollHeight });

    noteLiveReplyEvent({ eventId: "d1", provider: "claudeAgent", threadId: "thread", createdAt: "", turnId: "t", type: "content.delta", streamKind: "assistant_text", delta: "Streaming words " } as RuntimeEvent);
    grow();
    expect(scroller.calls.at(-1)).toEqual({ top: scroller.scrollHeight, behavior: "smooth" });

    readUpTo(view, 100);
    const calls = scroller.calls.length;
    grow();
    grow();
    expect(scroller.calls.length - calls, "the reader scrolled up: growth leaves them where they are").toBe(0);
    expect(scroller.scrollTop).toBe(100);
  });

  it("offers Jump to latest only a moment after the reader leaves the end, and hides it at once on return", () => {
    vi.useFakeTimers();
    try {
      const view = mount({ messages: rows(60) });
      readUpTo(view, 300);
      expect(view.current.showJumpToLatest, "not on the first frame away").toBe(false);
      view.act(() => void vi.advanceTimersByTime(150));
      expect(view.current.showJumpToLatest).toBe(true);
      view.act(() => {
        scroller.scrollTop = scroller.bottom;
        view.current.scrollHandlers.onScroll();
      });
      expect(view.current.following).toBe(true);
      expect(view.current.showJumpToLatest).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a switch draws the newest rows first", () => {
  it("draws from the twentieth newest row, and the rest once the frame is painted", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const view = mount({ messages: rows(80) });
      view.rerender({ threadId: "other", messages: rows(80, 500) });
      expect(view.current.drawFrom).toBe("m560");
      view.act(() => {});
      expect(view.current.drawFrom, "the frame callback only queues the fill").toBe("m560");
      vi.advanceTimersByTime(0);
      view.rerender({});
      expect(view.current.drawFrom).toBeUndefined();
      expect(scroller.scrollTop, "still at the end").toBeGreaterThanOrEqual(scroller.bottom);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no frame or timer behind when the chat goes away before the paint", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const view = mount({ messages: rows(80) });
      view.rerender({ threadId: "other", messages: rows(80, 500) });
      expect(view.current.drawFrom).toBe("m560");
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
      expect(frames).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a short chat, or a jump to an older message, at once", () => {
    const view = mount({ messages: rows(80) });
    view.rerender({ threadId: "other", messages: rows(15, 500) });
    expect(view.current.drawFrom).toBeUndefined();
    store.state.focusMessage = { threadId: "third", messageId: "m700", nonce: 7, consumed: false };
    view.rerender({ threadId: "third", messages: rows(80, 700) });
    expect(view.current.drawFrom).toBeUndefined();
  });
});
