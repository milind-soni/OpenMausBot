import type { EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effect: null as EffectCallback | null, text: "", dispatch: vi.fn() }));
vi.mock("react", () => ({ useEffect: (effect: EffectCallback) => { fixture.effect = effect; } }));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { focusMessage: { threadId: "thread", messageId: "message", matchText: fixture.text, nonce: 1, consumed: false } }, dispatch: fixture.dispatch }),
}));

import { useFocusMessage } from "./focus-message";

let cleanup: (() => void) | undefined;
let ranges: Array<{ start: number; end: number }>;
let highlights: Map<string, unknown>;
let target: { scrollIntoView: ReturnType<typeof vi.fn>; classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }; querySelector: () => unknown; querySelectorAll: () => { item: () => unknown; length: number } };
beforeEach(() => {
  vi.useFakeTimers();
  fixture.dispatch.mockClear();
  ranges = [];
  highlights = new Map();
  const node = { data: "alpha\nbeta a.b", length: 14 };
  target = { scrollIntoView: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() }, querySelector: () => target, querySelectorAll: () => ({ item: () => target, length: 1 }) };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("CSS", { escape: (value: string) => value, highlights });
  vi.stubGlobal("Highlight", class { constructor(readonly range: unknown) {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("document", {
    querySelector: () => ({ lastElementChild: target }),
    createTreeWalker: () => {
      let available = true;
      return { currentNode: node, nextNode: () => { const result = available; available = false; return result; } };
    },
    createRange: () => {
      const range = { start: -1, end: -1, setStart: (_node: unknown, offset: number) => { range.start = offset; }, setEnd: (_node: unknown, offset: number) => { range.end = offset; } };
      ranges.push(range);
      return range;
    },
  });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

function focus(text: string) {
  fixture.text = text;
  useFocusMessage("thread", true);
  cleanup = fixture.effect!() as () => void;
}

describe("search match highlighting", () => {
  it.each(["", " ", "\t\r\n"])("does not create an empty range for %j", (text) => {
    focus(text);
    expect(ranges).toEqual([]);
    expect(highlights.size).toBe(0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "focusMessageConsumed", nonce: 1 });
  });

  it.each([[" alpha beta ", 0, 10], ["a.b", 11, 14]])("keeps the literal nonempty match %j", (text, start, end) => {
    focus(text as string);
    expect(ranges).toMatchObject([{ start, end }]);
    expect(highlights.has("search-result-text")).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
  });
});
