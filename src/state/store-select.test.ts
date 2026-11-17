// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./app-store";
import { initialState, reducer, type Action, type AppState, type Bot } from "./store";
import { StoreContext, StoreSourceContext, type StoreSource, type StoreValue } from "./store-context";
import { sameFields, sameItems, useStoreActions, useStoreSelector } from "./store-select";

const bot = (id: string, name = id): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" }, messages: [],
} as unknown as Bot);

function storeWith(state: Partial<AppState>) {
  const store = createAppStore<AppState, Action, never>(reducer, { ...initialState, ...state }, (flush) => { flush(); return () => {}; });
  const source: StoreSource = {
    getState: store.getState, subscribe: store.subscribe, dispatch: store.dispatch,
    flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
  };
  return { store, source };
}

let root: Root | null = null;
function mount(source: StoreSource, child: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(StoreSourceContext, { value: source }, child)));
}
const act = (fn: () => void) => flushSync(fn);
afterEach(() => { flushSync(() => root?.unmount()); root = null; });

describe("useStoreSelector", () => {
  it("renders again only when its slice changes", () => {
    const { store, source } = storeWith({ bots: [bot("a"), bot("b")], connected: true });
    const names: string[] = [];
    function Name({ id }: { id: string }) {
      names.push(useStoreSelector((state) => state.bots.find((candidate) => candidate.id === id)?.name ?? ""));
      return null;
    }
    mount(source, createElement(Name, { id: "b" }));
    expect(names).toEqual(["b"]);
    act(() => store.dispatch({ type: "botPatched", bot: { ...bot("a"), name: "renamed a" } }));
    act(() => store.dispatch({ type: "connected", value: false }));
    expect(names, "a change to another bot or another field draws nothing").toEqual(["b"]);
    act(() => store.dispatch({ type: "botPatched", bot: { ...bot("b"), name: "renamed b" } }));
    expect(names).toEqual(["b", "renamed b"]);
  });

  it("keeps the earlier value while `equal` says it is the same", () => {
    const { store, source } = storeWith({ bots: [bot("a"), bot("b")] });
    const seen: Array<readonly string[]> = [];
    function Ids() {
      seen.push(useStoreSelector((state) => state.bots.map((candidate) => candidate.id), sameItems));
      return null;
    }
    mount(source, createElement(Ids));
    act(() => store.dispatch({ type: "botPatched", bot: { ...bot("a"), name: "renamed" } }));
    expect(seen).toHaveLength(1);
    act(() => store.dispatch({ type: "botsOrdered", botIds: ["b", "a"] }));
    expect(seen.map((ids) => [...ids])).toEqual([["a", "b"], ["b", "a"]]);
  });

  it("without `equal`, a new object each read is a change", () => {
    const { store, source } = storeWith({ bots: [bot("a")] });
    let renders = 0;
    function Ids() {
      useStoreSelector((state) => state.bots.map((candidate) => candidate.id));
      renders++;
      return null;
    }
    mount(source, createElement(Ids));
    act(() => store.dispatch({ type: "connected", value: !store.getState().connected }));
    expect(renders).toBe(2);
  });

  it("reads anew when its selector names another slice", () => {
    const { source } = storeWith({ bots: [bot("a", "Ada"), bot("b", "Bea")] });
    const names: string[] = [];
    function Name({ id }: { id: string }) {
      names.push(useStoreSelector((state) => state.bots.find((candidate) => candidate.id === id)!.name));
      return null;
    }
    mount(source, createElement(Name, { id: "a" }));
    flushSync(() => root!.render(createElement(StoreSourceContext, { value: source }, createElement(Name, { id: "b" }))));
    expect(names).toEqual(["Ada", "Bea"]);
  });

  it("compares a record of slices field by field", () => {
    expect(sameFields({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(sameFields({ a: 1, b: "x" }, { a: 1, b: "y" })).toBe(false);
    expect(sameFields({ a: 1 } as Record<string, number>, { a: 1, b: 2 })).toBe(false);
    expect(sameItems([1, 2], [1, 2])).toBe(true);
    expect(sameItems([1, 2], [2, 1])).toBe(false);
    expect(sameItems([1], [1, 2])).toBe(false);
  });

  it("follows a store given as a plain value, as a preview or a bot editor gives it", () => {
    const value = (connected: boolean): StoreValue => ({
      state: { ...initialState, connected }, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
    });
    const seen: boolean[] = [];
    function Connected() {
      seen.push(useStoreSelector((state) => state.connected));
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(StoreContext.Provider, { value: value(false) }, createElement(Connected))));
    flushSync(() => root!.render(createElement(StoreContext.Provider, { value: value(true) }, createElement(Connected))));
    expect(seen).toEqual([false, true]);
  });
});

describe("useStoreActions", () => {
  it("never renders again for a state change", () => {
    const { store, source } = storeWith({});
    let renders = 0;
    function Actions() {
      useStoreActions();
      renders++;
      return null;
    }
    mount(source, createElement(Actions));
    act(() => store.dispatch({ type: "connected", value: !store.getState().connected }));
    expect(renders).toBe(1);
  });
});
