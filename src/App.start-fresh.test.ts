// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, type Action, type AppState, type Bot, type Message } from "./state/store";

const text: Message = { id: "m1", role: "user", kind: "text", text: "hello", at: 1 };
const fresh: Message = {
  id: "m2", role: "bot", kind: "compaction", at: 2, parentId: "m1",
  compaction: { summary: "", firstKeptId: "", foldedThroughId: "m1", tokensBefore: 0, by: "person", fresh: true },
};
const bot: Bot = {
  id: "pepper", threadId: "side", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [text], activeLeafId: "m1",
  modelSelection: { instanceId: "test", model: "m" },
};

let state: AppState;
let dispatched: Action[];
vi.mock("./state/store", async (original) => ({
  ...await original<typeof import("./state/store")>(),
  StoreProvider: ({ children }: { children: unknown }) => children,
  useStore: () => ({ state, dispatch: (action: Action) => { dispatched.push(action); }, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
vi.mock("./lib/analytics", () => ({ initAnalytics: () => {}, track: () => {}, emailGateDone: () => true }));
const { default: App } = await import("./App");

let fetched: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

const render = () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rerender();
};
const rerender = () => flushSync(() => root.render(createElement(App)));
const press = async (init: KeyboardEventInit = {}) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", metaKey: true, shiftKey: true, bubbles: true, ...init }));
  await Promise.resolve();
};
const startFreshCalls = () => fetched.mock.calls.filter(([url]) => String(url).includes("/start-fresh"));

beforeEach(() => {
  state = { ...initialState, connected: true, hydrated: true, selectedId: bot.id, bots: [bot] };
  dispatched = [];
  fetched = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetched);
  (window as { ogb?: unknown }).ogb = { environments: { onOpenSettings: () => () => {} } };
  render();
});
afterEach(() => {
  root.unmount();
  container.remove();
  delete (window as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

it("starts the selected chat fresh on ⌘⇧K", async () => {
  await press();
  expect(startFreshCalls()).toHaveLength(1);
  const [url, init] = startFreshCalls()[0]!;
  expect(url).toBe("/api/bots/pepper/start-fresh");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ threadId: "side" });
});

it("leaves the shortcut alone while busy, empty, already fresh, read-only or with the shortcut sheet open", async () => {
  for (const change of [
    { bots: [{ ...bot, busy: true }] },
    { bots: [{ ...bot, messages: [] }] },
    { bots: [{ ...bot, messages: [text, fresh], activeLeafId: "m2" }] },
    { bots: [{ ...bot, yourAccess: "view" as const }] },
    { bots: [{ ...bot, switchingTo: "other" }] },
    { activeView: "routines" as const },
    { shortcutsOpen: true },
  ]) {
    state = { ...state, ...change };
    rerender();
    await press();
  }
  expect(startFreshCalls()).toHaveLength(0);
});

it("sends one request for presses made before the first settles", async () => {
  let release: (value: Response) => void = () => {};
  fetched.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
  await press();
  await press({ repeat: true });
  expect(startFreshCalls()).toHaveLength(1);
  release(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await press();
  expect(startFreshCalls()).toHaveLength(2);
});
