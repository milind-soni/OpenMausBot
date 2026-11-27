import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reducer, StoreProvider, useStore, type Action, type Bot } from "./store";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// Capture the real command handler without mounting live event effects.
function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return dispatch;
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("New bot", () => {
  const bot = { id: "created", threadId: "created-main", name: "Scout", messages: [] };
  const defaults = { defaults: { profile: {}, memory: {}, skills: [], routines: [] }, modelSelection: { instanceId: "claude", model: "sonnet" }, suggestedName: "Scout" };
  const server = (create: () => Promise<Response>) => vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path === "/api/bot-defaults") return response(defaults);
    if (path === "/api/bots" && init?.method === "POST") return create();
    if (path === "/api/bots/created" && init?.method === "PATCH") return response({ bot });
    return response({});
  });
  const creates = (request: ReturnType<typeof server>) => request.mock.calls.filter(([path, init]) => path === "/api/bots" && init?.method === "POST").length;

  it("makes one bot from a double click", async () => {
    const post = deferred();
    const request = server(() => post.promise);
    const dispatch = mount(request);
    const onCreated = vi.fn();
    dispatch({ type: "newBot", onCreated });
    dispatch({ type: "newBot", onCreated });
    await vi.waitFor(() => expect(creates(request)).toBe(1));
    dispatch({ type: "newBot", onCreated });
    post.resolve(response({ bot }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    await flush();
    expect(creates(request)).toBe(1);
  });

  it("lets the next click try again after a failure", async () => {
    let fail = true;
    const request = server(async () => {
      if (fail) { fail = false; throw new Error("offline"); }
      return response({ bot });
    });
    const dispatch = mount(request);
    const onError = vi.fn();
    const onCreated = vi.fn();
    dispatch({ type: "newBot", onError, onCreated });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Couldn't make a new bot: offline"));
    expect(onCreated).not.toHaveBeenCalled();
    await flush();
    dispatch({ type: "newBot", onCreated });
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(creates(request)).toBe(2);
  });
});

describe("setup navigation", () => {
  it.each([false, true])("preserves the current selection only for nested team creation (%s)", preserveSelection => {
    const bot = { id: "created", name: "Scout", messages: [] } as unknown as Bot;
    const state = { ...initialState, activeView: "team-map" as const, selectedId: "existing" };
    const next = reducer(state, { type: "botAdded", bot, preserveSelection });
    expect(next.bots).toContain(bot);
    expect(next.activeView).toBe(preserveSelection ? "team-map" : "chat");
    expect(next.selectedId).toBe(preserveSelection ? "existing" : "created");
    expect(reducer(state, { type: "botAdded", bot })).toMatchObject({ activeView: "chat", selectedId: "created" });
  });

  it("puts the new bot's chat in front of any open settings, except from a department's own dialog", () => {
    const start = { ...initialState, settingsOpen: true, appSettingsOpen: true, pluginsOpen: true, shortcutsOpen: true, computerOpen: true };
    expect(reducer(start, { type: "newBot" })).toMatchObject({ settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false, computerOpen: true });
    expect(reducer(start, { type: "newBot", section: "Sales", preserveSelection: true })).toBe(start);
  });

  it("opens the requested Plugins surface and remembers it on reopen", () => {
    const next = reducer({ ...initialState, settingsOpen: true }, { type: "togglePlugins", open: true, surface: "mcp" });
    expect(next).toMatchObject({ pluginsOpen: true, pluginsSurface: "mcp", settingsOpen: false });
    const closed = reducer(next, { type: "togglePlugins", open: false });
    expect(reducer(closed, { type: "togglePlugins", open: true })).toMatchObject({ pluginsSurface: "mcp" });
  });
});
