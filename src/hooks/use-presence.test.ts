import type { EffectCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type Action, type AppState, type Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], refs: [] as Array<{ current: unknown }>, refAt: 0, showThreads: true, api: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
  useRef: (initial: unknown) => { const at = fixture.refAt++; fixture.refs[at] ??= { current: initial }; return fixture.refs[at]; },
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));

import { usePresence } from "./use-presence";

const chief: Bot = {
  id: "chief", threadId: "chief-main", name: "Chief", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" }, chiefOfStaff: true,
  tasks: [{ threadId: "chief-main", title: "Main", createdAt: 1 }, { threadId: "chief-2", title: "Plans", createdAt: 2 }],
};
const scout: Bot = { ...chief, id: "scout", threadId: "scout-main", name: "Scout", chiefOfStaff: false, tasks: [{ threadId: "scout-main", title: "Main", createdAt: 1 }] };
const loading: AppState = { ...initialState, bots: [], selectedId: "" };
const loaded: AppState = { ...initialState, bots: [chief], selectedId: "chief", hydrated: true };
const team: AppState = { ...loaded, bots: [chief, scout] };
const toChief = { ok: true, returned: true, open: { botId: "chief", threadId: "chief-main" } };

/** One render with changed dependencies: run its effects in order, as React would after commit. */
function render(state: AppState, dispatch: (action: Action) => void) {
  fixture.effects = [];
  fixture.refAt = 0;
  usePresence(state, dispatch);
  return fixture.effects.map((effect) => effect());
}
/** A render whose `state.hydrated` is unchanged: React keeps the effect, so it is not run again. */
function rerender(state: AppState, dispatch: (action: Action) => void) {
  fixture.refAt = 0;
  usePresence(state, dispatch);
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Listener = { scope: "window" | "document"; name: string; fn: () => void; options?: unknown };
function stubDom(options: { visibilityState?: "visible" | "hidden"; ogb?: unknown } = {}) {
  const added: Listener[] = [];
  const removed: Listener[] = [];
  const target = (scope: Listener["scope"]) => ({
    addEventListener: (name: string, fn: () => void, listenerOptions?: unknown) => { added.push({ scope, name, fn, options: listenerOptions }); },
    removeEventListener: (name: string, fn: () => void) => { removed.push({ scope, name, fn }); },
  });
  const doc = { ...target("document"), visibilityState: options.visibilityState ?? "visible" };
  vi.stubGlobal("window", { ogb: options.ogb, ...target("window") });
  vi.stubGlobal("document", doc);
  const fire = (name: string) => { for (const listener of added.filter((entry) => entry.name === name)) listener.fn(); };
  return { added, removed, doc, fire };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.effects = [];
  fixture.refs = [];
  fixture.refAt = 0;
  fixture.api.mockReset();
});

describe("usePresence", () => {
  it("posts presence once the bots are loaded, and opens the Chief's chat when a card landed while away", async () => {
    stubDom();
    fixture.api.mockResolvedValue(toChief);
    const dispatch = vi.fn();
    render(loading, dispatch);
    expect(fixture.api).not.toHaveBeenCalled();
    render(loaded, dispatch);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/presence/active", { method: "POST", body: JSON.stringify({ source: "desktop", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "chief" },
      { type: "switchTask", botId: "chief", threadId: "chief-main" },
      { type: "revealThread", threadId: "chief-main" },
    ]);
  });

  it.each([
    ["an unknown bot", { botId: "nobody", threadId: "chief-main" }],
    ["a thread that belongs to another bot", { botId: "chief", threadId: "scout-main" }],
    ["a thread the viewer no longer has", { botId: "chief", threadId: "gone" }],
  ])("opens nothing for an answer naming %s", async (_name, open) => {
    stubDom();
    fixture.api.mockResolvedValue({ ok: true, returned: true, open });
    const dispatch = vi.fn();
    render(team, dispatch);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("waits for a hidden window to be shown before the first ping", async () => {
    const dom = stubDom({ visibilityState: "hidden" });
    fixture.api.mockResolvedValue(toChief);
    const dispatch = vi.fn();
    render(loaded, dispatch);
    await flush();
    expect(fixture.api).not.toHaveBeenCalled();
    dom.fire("visibilitychange");
    await flush();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    dom.doc.visibilityState = "visible";
    dom.fire("visibilitychange");
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalled();
  });

  it("pings again on focus, at most once a minute, and ignores a failed call", async () => {
    const dom = stubDom();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fixture.api.mockRejectedValue(new Error("404"));
    const dispatch = vi.fn();
    render(loaded, dispatch);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    dom.fire("focus");
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 61_000);
    dom.fire("visibilitychange");
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("counts typing and clicks in the window as the person being here, at most once a minute", async () => {
    const dom = stubDom();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fixture.api.mockResolvedValue({ ok: true, returned: false });
    render(loaded, vi.fn());
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 60_000);
    dom.fire("keydown");
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_000_000 + 90_000);
    dom.fire("keydown");
    dom.fire("pointerdown");
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_000_000 + 120_000);
    dom.fire("pointerdown");
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(3);
    for (const name of ["pointerdown", "keydown"]) {
      expect(dom.added.find((listener) => listener.scope === "window" && listener.name === name)?.options).toEqual({ passive: true });
    }
  });

  it.each([
    ["another bot", { ...team, selectedId: "scout" }],
    ["another of the Chief's threads", { ...team, bots: [{ ...chief, switchingTo: "chief-2" }, scout] }],
  ])("leaves the person where they went when they opened %s while the ping was in flight", async (_name, moved) => {
    stubDom();
    let answer: (value: unknown) => void = () => {};
    fixture.api.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const dispatch = vi.fn();
    render(team, dispatch);
    rerender(moved, dispatch);
    answer(toChief);
    await flush();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still opens the Chief's chat when only other state changed while the ping was in flight", async () => {
    stubDom();
    let answer: (value: unknown) => void = () => {};
    fixture.api.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const dispatch = vi.fn();
    render(team, dispatch);
    rerender({ ...team, bots: [{ ...chief, unread: true }, scout] }, dispatch);
    answer(toChief);
    await flush();
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "chief" },
      { type: "switchTask", botId: "chief", threadId: "chief-main" },
      { type: "revealThread", threadId: "chief-main" },
    ]);
  });

  it("removes every listener it added when it unmounts", () => {
    const dom = stubDom();
    fixture.api.mockResolvedValue({ ok: true, returned: false });
    const cleanups = render(loaded, vi.fn());
    expect(dom.added.map(({ scope, name }) => `${scope}:${name}`).sort()).toEqual(["document:visibilitychange", "window:focus", "window:keydown", "window:pointerdown"]);
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    const pairs = (listeners: Listener[]) => listeners.map(({ scope, name, fn }) => [`${scope}:${name}`, fn] as const).sort(([a], [b]) => a.localeCompare(b));
    expect(pairs(dom.removed)).toEqual(pairs(dom.added));
  });

  it("pings in companion client mode too, where the companion lets the route through", async () => {
    stubDom({ ogb: { remoteClient: { active: true } } });
    fixture.api.mockResolvedValue({ ok: true, returned: false });
    render(loaded, vi.fn());
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/presence/active", expect.objectContaining({ method: "POST" }));
  });
});
