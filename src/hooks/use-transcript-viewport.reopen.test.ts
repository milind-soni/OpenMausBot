// Runs against a small stand-in for React's hooks (no DOM), a scroller whose height is its mounted row count, and rows a
// text selection can span.
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
import { SELECTION_HOLD_MAX, TRANSCRIPT_WINDOW_MAX } from "@/lib/transcript-window";
import { forgetTranscriptPositions } from "@/lib/transcript-follow";
import { resetLiveReplies } from "@/state/live-reply";

type Row = { id: string; role?: "user" | "bot" };
const rows = (count: number, from = 0): Row[] => Array.from({ length: count }, (_, index) => ({ id: `m${from + index}` }));

const ROW = 50;
let heightOf = (_row: Row) => ROW;
class Scroller {
  rows = 0;
  content = 0;
  extra = 0;
  scrollTop = 0;
  clientHeight = 400;
  clientWidth = 400;
  calls: ScrollToOptions[] = [];
  get scrollHeight() {
    return this.content + this.extra;
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

type FakeRow = { nodeType: 1; dataset: { mid: string }; parentElement: null; closest(): FakeRow; getBoundingClientRect(): { top: number; bottom: number; height: number } };
const elements = new Map<string, FakeRow>();
let drawn: readonly Row[] = [];
const rowElement = (id: string): FakeRow => {
  let element = elements.get(id);
  if (!element) {
    element = {
      nodeType: 1, dataset: { mid: id }, parentElement: null, closest: () => element!,
      getBoundingClientRect: () => {
        const index = drawn.findIndex((row) => row.id === id);
        const top = index * ROW - scroller.scrollTop;
        return { top, bottom: top + ROW, height: ROW };
      },
    };
    elements.set(id, element);
  }
  return element;
};
/** The person's text selection, from the start of one row to the start of another. */
let selection: { from: string; to: string } | null = null;
let selectionDropped = 0;
const pageSelection = () => {
  if (!selection) return { rangeCount: 0, isCollapsed: true };
  const range = { startContainer: rowElement(selection.from), endContainer: rowElement(selection.to), startOffset: 0, endOffset: 0, intersectsNode: () => true };
  return {
    rangeCount: 1, isCollapsed: false, getRangeAt: () => range, anchorNode: range.startContainer, anchorOffset: 0,
    focusNode: range.endContainer, focusOffset: 0, toString: () => "", removeAllRanges: () => { selectionDropped++; selection = null; },
  };
};
const transcriptOf = (shown: readonly Row[]) => {
  drawn = shown;
  return {
    querySelectorAll: () => shown.map((row) => rowElement(row.id)),
    contains: (node: unknown) => shown.some((row) => elements.get(row.id) === node),
    ownerDocument: { getSelection: pageSelection },
  };
};

type Props = Parameters<typeof useTranscriptViewport<Row>>[0];
let scroller: Scroller;
let frames: FrameRequestCallback[];
let keyListeners: Set<(event: Partial<KeyboardEvent>) => void>;
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
    scroller.content = result.windowedMessages.reduce((sum, row) => sum + heightOf(row), 0);
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
  heightOf = () => ROW;
  frames = [];
  keyListeners = new Set();
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
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor() {}
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("document", {});
  elements.clear();
  selection = null;
  selectionDropped = 0;
  vi.stubGlobal("HTMLInputElement", class {});
  return () => {
    unmount();
    vi.unstubAllGlobals();
  };
});

describe("a conversation held as a short tail, opened again", () => {
  const topId = (view: ReturnType<typeof mount>) => view.current.windowedMessages[Math.floor(scroller.scrollTop / ROW)]!.id;
  const scrollTo = (view: ReturnType<typeof mount>, top: number) => view.act(() => {
    scroller.scrollTop = top;
    view.current.scrollHandlers.onScroll();
  });
  /** Every drawn row is the conversation's own, in order, with none skipped. */
  const contiguous = (view: ReturnType<typeof mount>, held: readonly Row[]) => {
    const shown = view.current.windowedMessages.map((row) => row.id);
    const from = held.findIndex((row) => row.id === shown[0]);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(shown).toEqual(held.slice(from, from + shown.length).map((row) => row.id));
  };
  const drawnIds = (view: ReturnType<typeof mount>) => view.current.windowedMessages.map((row) => row.id);

  /** Opens a tail of 20, takes the page before it, then reads up to the first row, paging the rest in when it runs out. */
  function readToTheTop(selected: { from: string; to: string } | null) {
    let held = rows(20, 380);
    const view = mount({ messages: held, hasMore: true });
    held = [...rows(200, 180), ...held];
    view.rerender({ messages: held, hasMore: true });
    expect(view.current.windowedMessages.at(-1)?.id).toBe("m399");
    contiguous(view, held);
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    selection = selected;
    const asked: unknown[] = [];
    for (let steps = 0; view.current.windowedMessages[0]?.id !== "m0" && steps < 100; steps++) {
      if (view.current.hiddenCount === 0) {
        dispatched = [];
        scrollTo(view, 900);
        scrollTo(view, 100);
        asked.push(...dispatched);
        const reading = topId(view);
        held = [...rows(180, 0), ...held];
        view.rerender({ messages: held, hasMore: false });
        expect(topId(view), "the row at the top stays the row at the top as the page lands").toBe(reading);
      } else {
        scrollTo(view, 900);
        scroller.scrollTop = 100;
        const reading = topId(view);
        view.act(() => view.current.scrollHandlers.onScroll());
        expect(topId(view), "the row at the top stays the row at the top").toBe(reading);
      }
      contiguous(view, held);
      if (selected) expect(drawnIds(view), "the selected rows stay drawn").toEqual(expect.arrayContaining(["m380", "m383", "m385"]));
    }
    expect(asked, "past the rows held it asks the server instead of stepping into rows it does not have").toEqual([{ type: "loadOlderMessages", threadId: "thread" }]);
    expect(view.current.windowedMessages[0]?.id).toBe("m0");
    return view;
  }

  it("steps toward older rows over the page paged back in, keeping the selection and the row under the reader", () => {
    const view = readToTheTop({ from: "m380", to: "m385" });
    expect(view.current.windowedMessages.length).toBeLessThanOrEqual(SELECTION_HOLD_MAX);
    expect(view.current.windowedMessages.length).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX);
    expect(selection, "the selection was never taken off the page").toEqual({ from: "m380", to: "m385" });
    expect(selectionDropped).toBe(0);
  });

  it("lets those rows go when nothing is selected", () => {
    const view = readToTheTop(null);
    expect(view.current.windowedMessages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
    expect(drawnIds(view)).not.toContain("m385");
  });

  it("draws only rows it holds while the page before the tail is on its way", () => {
    const held = rows(20, 380);
    const view = mount({ messages: held, hasMore: true });
    selection = { from: "m385", to: "m390" };
    view.act(() => view.current.scrollHandlers.onWheel({ deltaY: -40 } as never));
    dispatched = [];
    scrollTo(view, 0);
    expect(view.current.hiddenCount).toBe(0);
    expect(dispatched).toEqual([{ type: "loadOlderMessages", threadId: "thread" }]);
    expect(drawnIds(view)).toEqual(held.map((row) => row.id));
    expect(selectionDropped).toBe(0);
  });
});
