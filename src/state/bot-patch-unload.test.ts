// @vitest-environment happy-dom
import { act, createElement, type Dispatch } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRelayLink } from "../lib/relay-server";
import { initialState, StoreProvider, useStore, type Action, type BotAnnouncement } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Chaos", title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" }, tasks: [],
};
afterEach(() => { initialState.bots = []; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("saves an Instructions edit at once when the page is left before the save's pause ends", async () => {
  vi.useFakeTimers();
  initialState.bots = [{ ...bot, messages: [] }];
  const patches: string[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path, init) => {
    if (path === "/api/bots/bot" && init?.method === "PATCH") patches.push(String(init.body));
    return new Response(JSON.stringify(path === "/api/bots/bot" ? { bot } : {}));
  }));
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Capture))));
  act(() => dispatch({ type: "updateBot", botId: "bot", patch: { soul: "chaos instructions v3." } }));
  window.dispatchEvent(new Event("pagehide"));
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(patches.map((body) => JSON.parse(body).soul)).toEqual(["chaos instructions v3."]);
  act(() => root.unmount());
});

it("sends only the leaving page's save as keepalive, so ordinary saves never use up the browser's keepalive budget", async () => {
  vi.useFakeTimers();
  initialState.bots = [{ ...bot, messages: [] }];
  const keepalive: Array<boolean | undefined> = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path, init) => {
    if (path === "/api/bots/bot" && init?.method === "PATCH") keepalive.push(init.keepalive);
    return new Response(JSON.stringify(path === "/api/bots/bot" ? { bot } : {}));
  }));
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Capture))));
  act(() => dispatch({ type: "updateBot", botId: "bot", patch: { soul: "v1" } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(450); });
  act(() => dispatch({ type: "updateBot", botId: "bot", patch: { soul: "v2" } }));
  window.dispatchEvent(new Event("pagehide"));
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(keepalive.map(Boolean)).toEqual([false, true]);
  act(() => root.unmount());
});

describe("on a relay pairing", () => {
  const hide = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => { setRelayLink(null); Reflect.deleteProperty(document, "visibilityState"); });

  async function mount(relayed: boolean) {
    vi.useFakeTimers();
    initialState.bots = [{ ...bot, messages: [] }];
    const patches: string[] = [];
    const answer = (path: string, method?: string, body?: string) => {
      if (path === "/api/bots/bot" && method === "PATCH") patches.push(String(body));
      return new Response(JSON.stringify(path === "/api/bots/bot" ? { bot } : {}));
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path, init) => answer(String(path), init?.method, String(init?.body))));
    if (relayed) setRelayLink({ fetch: async (path, request) => answer(path, request?.method, new TextDecoder().decode(request?.body ?? undefined)), close: () => {} });
    let dispatch!: Dispatch<Action>;
    function Capture() { dispatch = useStore().dispatch; return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Capture))));
    act(() => dispatch({ type: "updateBot", botId: "bot", patch: { soul: "written on a phone away from home." } }));
    return { patches, root };
  }

  it("saves a waiting edit as soon as the page is hidden, while the link still carries it", async () => {
    const { patches, root } = await mount(true);
    hide("hidden");
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    expect(patches.map((body) => JSON.parse(body).soul)).toEqual(["written on a phone away from home."]);
    act(() => root.unmount());
  });

  it("leaves the save's pause alone when the page is hidden off the relay, or shown again", async () => {
    const { patches, root } = await mount(false);
    hide("hidden");
    setRelayLink({ fetch: async () => new Response("{}"), close: () => {} });
    hide("visible");
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    expect(patches).toEqual([]);
    setRelayLink(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(patches.map((body) => JSON.parse(body).soul)).toEqual(["written on a phone away from home."]);
    act(() => root.unmount());
  });
});
