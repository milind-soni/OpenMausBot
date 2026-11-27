// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, StoreProvider, useStore } from "./store";
import { useStoreRef } from "./store-ref";
import type { StoreRef } from "./store-ref-context";

class FixtureEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
}

let store!: ReturnType<typeof useStore>;
let ref: StoreRef | null = null;
let storeRenders = 0, refRenders = 0;
function StoreReader() { store = useStore(); storeRenders++; return null; }
function RefReader() { ref = useStoreRef(); refRenders++; return null; }
let root: Root;

beforeEach(() => {
  storeRenders = 0;
  refRenders = 0;
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ bots: [], groups: [], instances: [] })));
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

const mount = (children: ReactNode) => flushSync(() => root.render(createElement(StoreProvider, null, createElement(StoreReader), children)));

describe("store ref", () => {
  it("reads the newest state without rendering again on a change", () => {
    mount(createElement(RefReader));
    const rendered = refRenders, first = ref;
    flushSync(() => store.dispatch({ type: "error", message: "Something broke" }));
    expect(storeRenders).toBeGreaterThan(1);
    expect(refRenders).toBe(rendered);
    expect(ref).toBe(first);
    expect(ref?.state().error).toBe("Something broke");
  });

  it("follows a bot editor's own store inside it", () => {
    mount(null);
    const scoped = { ...store, state: { ...store.state, error: "scoped" }, dispatch: vi.fn() };
    flushSync(() => root.render(createElement(StoreProvider, null, createElement(StoreReader),
      createElement(BotEditorStore, { value: scoped, children: createElement(RefReader) }))));
    expect(ref?.state().error).toBe("scoped");
    ref?.dispatch({ type: "error", message: null });
    expect(scoped.dispatch).toHaveBeenCalledOnce();
  });
});
