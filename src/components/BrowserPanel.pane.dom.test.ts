// @vitest-environment happy-dom
// On the desktop app with browserEngine.surface "pane", the panel tells the app where its page area is, and the
// app's native view hides whenever an overlay covers it; with the setting off the panel never asks.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const engine: { engine: string; kind: string; pane?: true } = { engine: "chrome", kind: "engine" };
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: { browserEngine: engine } }, dispatch: vi.fn() }) };
});
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));
vi.mock("@/lib/browser-pip", () => ({ supportsBrowserPictureInPicture: () => false, useBrowserPictureInPicture: () => "" }));
vi.mock("./browser/StreamSurface", async () => {
  const { useEffect } = await import("react");
  return {
    StreamSurface: (props: { onConnectedChange(next: boolean): void }) => {
      useEffect(() => { props.onConnectedChange(true); }, []);
      return null;
    },
  };
});
vi.mock("./browser/BrowserProfilesManager", () => ({ BrowserProfilesManager: () => null }));
vi.mock("./browser/MoreMenu", () => ({ MoreMenu: () => null }));
vi.mock("./browser/PasskeyNotice", () => ({ PasskeyNotice: () => null }));

const { LiveBrowser } = await import("./BrowserPanel");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};
const RECT = { left: 300, top: 120, width: 900, height: 700, right: 1200, bottom: 820, x: 300, y: 120, toJSON: () => ({}) };
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let host: HTMLDivElement;
let root: Root;
let show: ReturnType<typeof vi.fn>;
const pageArea = () => host.querySelector("[data-native-view-host]");

beforeEach(() => {
  show = vi.fn(async () => ({ shown: true }));
  (window as unknown as { ogb: unknown }).ogb = { browserPane: { show } };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete engine.pane;
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.restoreAllMocks();
});

describe("the browser panel's native pane", () => {
  it("never asks the app for a pane while the setting is off", async () => {
    flushSync(() => root.render(createElement(LiveBrowser, { bot })));
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(pageArea()).toBeNull();
  });

  it("shows the pane over the page area once connected, and hides it under an overlay and on leaving", async () => {
    engine.pane = true;
    flushSync(() => root.render(createElement(LiveBrowser, { bot })));
    await settle();
    expect(pageArea()).not.toBeNull();
    expect(show).toHaveBeenLastCalledWith({ botId: "scout", threadId: null, profile: null, bounds: { x: 300, y: 120, width: 900, height: 700 }, visible: true });

    const overlay = document.createElement("div");
    overlay.setAttribute("role", "menu");
    overlay.style.opacity = "1";
    document.body.append(overlay);
    await settle();
    expect(show.mock.calls.at(-1)?.[0]).toMatchObject({ visible: false });
    overlay.remove();
    await settle();
    expect(show.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true });

    flushSync(() => root.unmount());
    expect(show.mock.calls.at(-1)?.[0]).toEqual({ botId: "scout", threadId: null, profile: null, bounds: null, visible: false });
    root = createRoot(host);
  });
});
