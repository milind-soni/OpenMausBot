// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, type Action, type AppState } from "./state/store";

let state: AppState = { ...initialState, connected: true, hydrated: true };
let dispatched: Action[] = [];
const track = vi.fn();
vi.mock("./state/store", async (original) => ({
  ...await original<typeof import("./state/store")>(),
  StoreProvider: ({ children }: { children: unknown }) => children,
  useStore: () => ({ state, dispatch: (action: Action) => { dispatched.push(action); }, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
vi.mock("./lib/analytics", () => ({ initAnalytics: () => {}, track: (...args: unknown[]) => track(...args), emailGateDone: () => true }));
const { default: App } = await import("./App");

function render(cloudAdd: AppState["cloudAdd"], ogb?: unknown): { opened: ReturnType<typeof vi.fn>; done: () => void } {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const opened = vi.fn(() => null);
  vi.stubGlobal("open", opened);
  if (ogb) (window as { ogb?: unknown }).ogb = ogb;
  state = { ...initialState, connected: true, hydrated: true, cloudAdd };
  dispatched = []; track.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(App)));
  return { opened, done: () => { root.unmount(); container.remove(); } };
}

afterEach(() => { delete (window as { ogb?: unknown }).ogb; vi.unstubAllGlobals(); });

it("in a browser, Try Cloud opens the Cloud website's checkout in the same tap, counts it and leaves nothing waiting", () => {
  const { opened, done } = render({ source: "app_onboarding" });
  try {
    expect(opened).toHaveBeenCalledExactlyOnceWith("https://cloud.openmausbot.com/pro/buy?src=app_onboarding", "_blank", "noopener,noreferrer");
    expect(track).toHaveBeenCalledWith("cloud_checkout_opened", { plan: "pro", source: "app_onboarding", via: "web" });
    expect(dispatched).toContainEqual({ type: "closeCloudAdd" });
  } finally { done(); }
});

it("on a desktop showing another computer, it goes through main to the browser", () => {
  const openExternal = vi.fn(async () => {});
  const { opened, done } = render({ source: "app_card" }, { remoteClient: { active: true }, cloudAccount: {}, openExternal });
  try {
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://cloud.openmausbot.com/pro/buy?src=app_card");
    expect(opened).not.toHaveBeenCalled();
    expect(dispatched).toContainEqual({ type: "closeCloudAdd" });
  } finally { done(); }
});

it("on the desktop's own page the Add a Cloud dialog takes it, as before", () => {
  const openExternal = vi.fn(async () => {});
  const { opened, done } = render({ source: "app_onboarding" }, { cloudAccount: {}, openExternal });
  try {
    expect(opened).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith("cloud_checkout_opened", expect.anything());
    expect(dispatched).not.toContainEqual({ type: "closeCloudAdd" });
  } finally { done(); }
});
