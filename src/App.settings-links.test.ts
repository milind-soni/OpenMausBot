// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, type Action, type AppState } from "./state/store";

const state: AppState = { ...initialState, connected: true, hydrated: true };
let dispatched: Action[] = [];
vi.mock("./state/store", async (original) => ({
  ...await original<typeof import("./state/store")>(),
  StoreProvider: ({ children }: { children: unknown }) => children,
  useStore: () => ({ state, dispatch: (action: Action) => { dispatched.push(action); }, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
vi.mock("./lib/analytics", () => ({ initAnalytics: () => {}, track: () => {}, emailGateDone: () => true }));
const { default: App } = await import("./App");

let fromMain: ((section?: string) => void) | null = null;

function renderAt(path: string): () => void {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  window.history.replaceState(null, "", path);
  (window as { ogb?: unknown }).ogb = {
    environments: { onOpenSettings: () => () => {} },
    onOpenAppSettings: (cb: (section?: string) => void) => { fromMain = cb; return () => { fromMain = null; }; },
  };
  dispatched = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(App)));
  return () => { root.unmount(); container.remove(); };
}

const settingsOpened = () => dispatched.filter((action) => action.type === "toggleAppSettings");

afterEach(() => { delete (window as { ogb?: unknown }).ogb; fromMain = null; vi.unstubAllGlobals(); });

it("main's request for This computer's update or sign-out page opens Settings on that page", () => {
  const done = renderAt("/");
  try {
    fromMain?.("app");
    fromMain?.("account");
    fromMain?.(undefined);
    expect(settingsOpened()).toEqual([
      { type: "toggleAppSettings", open: true, section: "app" },
      { type: "toggleAppSettings", open: true, section: "account" },
      { type: "toggleAppSettings", open: true },
    ]);
  } finally { done(); }
});

it("main's request for the phone page opens the phone pairing, as the phone link does", () => {
  const done = renderAt("/");
  try {
    fromMain?.("phone");
    expect(settingsOpened()).toEqual([{ type: "toggleAppSettings", open: true, section: "phone", phonePairing: true }]);
  } finally { done(); }
  const linked = renderAt("/?desktop-settings=phone");
  try {
    expect(settingsOpened()).toEqual([{ type: "toggleAppSettings", open: true, section: "phone", phonePairing: true }]);
  } finally { linked(); }
});
