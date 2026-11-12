// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "./state/store";

vi.mock("./state/store", async (original) => ({
  ...await original<typeof import("./state/store")>(),
  StoreProvider: ({ children }: { children: ReactNode }) => children,
  useStore: () => ({ state: { ...initialState, connected: true, hydrated: true }, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
vi.mock("./lib/analytics", () => ({ initAnalytics: () => {}, track: () => {}, emailGateDone: () => true }));
const { default: App } = await import("./App");

afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  { row: "the app", remote: false },
  { row: "the remote client", remote: true },
])("closing a viewer window no open recorded in $row posts its close and gives back no one's control", ({ remote }) => {
  const posts: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => { posts.push({ url, body: String(init?.body) }); return new Promise(() => {}); });
  let closed: (viewer: { open: boolean; contextId: string | null }) => void = () => {};
  vi.stubGlobal("ogb", { ...(remote ? { remoteClient: { active: true } } : {}), desktopViewer: { onState: (listener: typeof closed) => { closed = listener; return () => {}; } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(createElement(App)));
    closed({ open: false, contextId: "scout" });
    expect(posts.filter((post) => post.url.startsWith("/api/bots/scout/"))).toEqual([{ url: "/api/bots/scout/computer/viewer-close", body: "{}" }]);
  } finally {
    root.unmount();
    container.remove();
  }
});
