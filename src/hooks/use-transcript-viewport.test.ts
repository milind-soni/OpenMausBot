// The transcript viewport shared by 1:1 chats and rooms: which rows mount,
// when the pane follows the bottom, and how it holds still while rows are
// prepended. Run against a small stand-in for React's hooks (the suite has
// no DOM) and a scroller whose height is its mounted row count.
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
  /** Render until state settles: a render-phase update re-renders before
   * committing, as React does; layout effects run before passive ones. */
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
vi.mock("@/state/store", () => ({ useStore: () => store }));
// Scrolling a search hit into view needs the real DOM; the window around it
// is what this suite checks.
vi.mock("@/lib/focus-message", () => ({ useFocusMessage: () => {} }));

import { useTranscriptViewport } from "./use-transcript-viewport";

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
}

type Props = Parameters<typeof useTranscriptViewport<Row>>[0];
let scroller: Scroller;
let frames: FrameRequestCallback[];
let keyListeners: Set<(event: Partial<KeyboardEvent>) => void>;
let observers: number;
let dispatched: unknown[];

function mount(initial: Partial<Props> = {}) {
  let props: Props = { ownerId: "bot", threadId: "thread", messages: rows(10), pinOn: [false], ...initial };
  let result!: ReturnType<typeof useTranscriptViewport<Row>>;
  const draw = () => {
    result = useTranscriptViewport(props);
  };
  // what React's commit does before layout effects: attach refs, lay out rows
  // (a browser clamps scrollTop when the content gets shorter)
  const commit = () => {
    result.scrollRef.current = scroller as unknown as HTMLDivElement;
    result.transcriptRef.current = {} as HTMLDivElement;
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
    /** A user event: handlers run, then React re-renders, then the frame. */
    act(handler: () => void) {
      handler();
      react.render(draw, commit);
      flushFrames();
    },
  };
}

beforeEach(() => {
  react.runtime.slots = [];
  scroller = new Scroller();
  frames = [];
  keyListeners = new Set();
  observers = 0;
  dispatched = [];
  store.state.focusMessage = null;
  store.state.loadingOlder = {};
  store.dispatch = (action) => dispatched.push(action);
  vi.stubGlobal("window", {
    addEventListener: (_: string, listener: (event: Partial<KeyboardEvent>) => void) => keyListeners.add(listener),
    removeEventListener: (_: string, listener: (event: Partial<KeyboardEvent>) => void) => keyListeners.delete(listener),
  });
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("ResizeObserver", class {
    constructor() {
      observers++;
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
  return () => vi.unstubAllGlobals();
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

    // the composer growing (or a busy flip) re-pins a following reader too
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

    // scrolling back down to the end resumes following
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

    // ArrowUp in the composer edits; outside it, it scrolls
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
    expect(view.current.hiddenCount).toBe(60);

    // opening a thread mounts one window, even when the person last wrote
    // long before its end
    view.rerender({ threadId: "other", messages: [{ id: "ask", role: "user" }, ...rows(299, 1_001)] });
    expect(view.current.transcriptKey).toBe("bot:other");
    expect(view.current.hiddenCount).toBe(180);
    expect(view.current.windowedMessages[0]?.id).toBe("m1180");
  });

  it("keeps the window bounded while the reader follows new rows", () => {
    const view = mount({ messages: rows(300) });
    for (let total = 301; total <= 900; total++) {
      view.rerender({ messages: rows(total) });
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(120);
      // rows leaving at the top leave a following reader at the bottom
      expect(scroller.scrollTop).toBe(scroller.bottom);
    }
    expect(view.current.windowedMessages[0]?.id).toBe("m780");
    expect(view.current.windowedMessages.at(-1)?.id).toBe("m899");
    expect(view.current.hiddenCount).toBe(780);
  });

  it("keeps the person's newest message mounted while a long turn follows it", () => {
    // tool steps draw nothing by default, so a turn can add far more rows
    // than the window holds while the question is still all there is to see
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

    // the next message ends that turn's hold, and the window is one window again
    view.rerender({ messages: [...thread, { id: "ask2", role: "user" }] });
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.windowedMessages.at(-1)?.id).toBe("ask2");
  });

  it("keeps the person's newest message mounted when many steps arrive at once", () => {
    const asked: Row[] = [...rows(30), { id: "ask", role: "user" }];
    const view = mount({ messages: asked });
    // a reconnect catching up delivers the turn's steps in one update
    view.rerender({ messages: [...asked, ...rows(150, 100)] });
    expect(view.current.windowedMessages[0]?.id).toBe("ask");
    expect(scroller.scrollTop).toBe(scroller.bottom);
  });

  it("keeps the window to two windows while one long stretch follows a single message", () => {
    // a long computer-use turn, or bots answering each other in a room: the
    // person wrote once and every row since then draws
    let thread: Row[] = [{ id: "ask", role: "user" }];
    const view = mount({ messages: thread });
    for (let step = 0; step < 600; step++) {
      thread = [...thread, { id: `step${step}`, role: "bot" }];
      view.rerender({ messages: thread });
      expect(view.current.windowedMessages.length).toBeLessThanOrEqual(2 * 120);
      expect(view.current.following).toBe(true);
      expect(scroller.scrollTop).toBe(scroller.bottom);
      // the question stays while the turn fits in one more window
      if (thread.length <= 2 * 120) expect(view.current.windowedMessages[0]?.id).toBe("ask");
    }
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.windowedMessages.at(-1)?.id).toBe("step599");
  });

  it("does not hold for a message that is already above the window", () => {
    // opened (or Jump to latest) in the middle of a long turn: the question
    // is behind Show earlier, so there is nothing on screen to hold
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

  it("holds the reader's rows and grows the window once they have scrolled away", () => {
    const view = mount({ messages: rows(300) });
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    scroller.scrollTop = 2_000;
    for (let total = 301; total <= 900; total++) view.rerender({ messages: rows(total) });
    expect(view.current.hiddenCount).toBe(180);
    expect(view.current.windowedMessages).toHaveLength(720);
    expect(scroller.scrollTop).toBe(2_000);
  });

  it("slides back to the latest window when the reader returns to the bottom", () => {
    const view = mount({ messages: rows(300) });
    view.act(() => view.current.showEarlier());
    view.rerender({ messages: rows(301) });
    expect(view.current.hiddenCount).toBe(60);

    view.act(() => {
      scroller.scrollTop = scroller.bottom;
      view.current.scrollHandlers.onScroll();
    });
    expect(view.current.following).toBe(true);
    expect(view.current.hiddenCount).toBe(181);
    expect(scroller.scrollTop).toBe(scroller.bottom);
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
    // a branch switch can shorten the thread without dropping below the
    // window's start; the person's newest message may now sit before it
    const view = mount({ messages: rows(300) });
    view.rerender({ messages: rows(620) });
    expect(view.current.hiddenCount).toBe(500);

    const branch: Row[] = [...rows(450), { id: "ask", role: "user" }, ...rows(109, 2_000)];
    view.rerender({ messages: branch });
    expect(view.current.hiddenCount).toBe(440);
    expect(view.current.windowedMessages).toHaveLength(120);
    expect(view.current.windowedMessages.map((row) => row.id)).toContain("ask");
    expect(scroller.scrollTop).toBe(scroller.bottom);

    // a reader who has scrolled away keeps the rows they are reading
    view.act(() => press("PageUp"));
    view.rerender({ messages: rows(500) });
    expect(view.current.hiddenCount).toBe(440);
  });

  it("shows earlier rows without moving the row under the reader", () => {
    const view = mount({ messages: rows(300) });
    scroller.scrollTop = 1_000;
    view.act(() => view.current.showEarlier());
    expect(view.current.windowedMessages[0]?.id).toBe("m60");
    expect(scroller.scrollTop).toBe(1_000 + 120 * ROW);
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
    expect(scroller.scrollTop).toBe(300 + 50 * ROW);
  });

  it("drops a height capture taken in the thread the reader left", () => {
    const view = mount({ messages: rows(50, 100) });
    scroller.scrollTop = 300;
    view.act(() => view.current.loadOlder());
    view.rerender({ threadId: "other", messages: rows(80, 500) });
    // the old thread's prepend is not applied; the new thread is followed
    expect(view.current.following).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.bottom);
    expect(scroller.scrollTop).not.toBe(300);
  });

  it("drops the capture on a switch even when the next thread opens on the same first row", () => {
    const view = mount({ messages: rows(50, 100) });
    scroller.scrollTop = 300;
    view.act(() => view.current.loadOlder());
    // Same window and first row: the thread change still drops the old
    // capture and follows the new transcript to its bottom.
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
    expect(view.current.laterCount).toBe(60);
  });

  it("keeps a search result's window when the reader scrolls to its end", () => {
    store.state.focusMessage = { threadId: "thread", messageId: "m10", nonce: 1, consumed: false };
    const view = mount({ messages: rows(300) });
    view.act(() => {
      scroller.scrollTop = scroller.bottom;
      view.current.scrollHandlers.onScroll();
    });
    expect(view.current.following).toBe(true);
    view.rerender({ messages: rows(301) });
    expect(view.current.windowedMessages[0]?.id).toBe("m0");
    expect(view.current.laterCount).toBe(181);
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

    // Leave the bottom and scroll near the top (<= AUTO_EXPAND_TOP_THRESHOLD)
    view.act(() => {
      scroller.scrollTop = 200;
      view.current.scrollHandlers.onWheel({ deltaY: -40 } as never);
      view.current.scrollHandlers.onScroll();
    });

    // Automatically expanded earlier messages without clicking a button
    expect(view.current.hiddenCount).toBe(60);
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
