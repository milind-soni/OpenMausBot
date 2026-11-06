// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot } from "./state/store";

let state: AppState;
vi.mock("./state/store", async (original) => ({
  ...await original<typeof import("./state/store")>(),
  StoreProvider: ({ children }: { children: ReactNode }) => children,
  useStore: () => ({ state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
vi.mock("./lib/analytics", () => ({ initAnalytics: () => {}, track: () => {}, emailGateDone: () => true }));
const { default: App } = await import("./App");

afterEach(() => { vi.unstubAllGlobals(); });

it("keeps a saved conversation visible through an unavailable engine status and recovery", () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const bot = { id: "pepper", threadId: "main", name: "Pepper", title: "", description: "", color: "green", tasks: [],
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    messages: [{ id: "saved", role: "user", text: "Saved conversation before the status failure", timestamp: 1 }],
  } as unknown as Bot;
  state = { ...initialState, connected: true, hydrated: true, bots: [bot], selectedId: bot.id,
    instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }] }, snapshot: { state: "unavailable", reason: "CLI probe timed out" } }],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(createElement(App)));
    expect(container.querySelector("[data-chathead-identity]")).not.toBeNull();
    expect(container.textContent).toContain("Saved conversation before the status failure");
    state = { ...state, instances: state.instances.map((instance) => ({ ...instance, snapshot: { state: "available", authenticated: true } })) };
    flushSync(() => root.render(createElement(App)));
    expect(container.textContent).toContain("Saved conversation before the status failure");
    expect(bot.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
  } finally {
    root.unmount();
    container.remove();
  }
});

it("offers AI setup when there is no conversation and every engine is unavailable", () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  state = { ...initialState, connected: true, hydrated: true,
    instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", models: { default: "", options: [] }, snapshot: { state: "unavailable" } }],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(createElement(App)));
    expect(container.querySelector("[data-chathead-identity]")).toBeNull();
    expect(container.textContent).toContain("Check again");
  } finally {
    root.unmount();
    container.remove();
  }
});
