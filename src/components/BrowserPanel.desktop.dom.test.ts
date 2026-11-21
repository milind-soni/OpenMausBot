// @vitest-environment happy-dom
// A Cloud browser shown as a remote desktop: the panel opens its stream without pictures, shows the desktop view once
// that stream says the browser runs, and keeps it over the picture's rectangle.
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

type SurfaceProps = {
  connect: (target: { width: number; height: number }, events: unknown) => unknown;
  onConnectedChange?: (connected: boolean) => void;
  onMessage?: (message: Record<string, unknown>) => void;
  onControl?: (control: unknown) => void;
};
const surfaces = vi.hoisted(() => [] as SurfaceProps[]);
const streams = vi.hoisted(() => [] as Array<{ query: Record<string, string> }>);

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  const config = { ...original.initialState.config, browserEngine: { kind: "engine", engine: "chrome", desktopView: true } };
  return { ...original, useStore: () => ({ state: { ...original.initialState, config }, dispatch: vi.fn() }) };
});
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));
vi.mock("@/lib/browser-pip", () => ({ supportsBrowserPictureInPicture: () => false, useBrowserPictureInPicture: () => "" }));
vi.mock("@/lib/browser-stream-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/browser-stream-client")>(),
  createPreviewStreamClient: (options: { access: { query: Record<string, string> } }) => { streams.push({ query: options.access.query }); return { send: () => {}, stop: () => {} }; },
}));
vi.mock("./browser/StreamSurface", () => ({
  StreamSurface: (props: SurfaceProps) => { surfaces.push(props); return createElement("div", { "data-stub-surface": "" }); },
}));
vi.mock("./browser/BrowserDesktop", () => ({ BrowserDesktop: () => createElement("div", { "data-stub-desktop": "" }) }));
vi.mock("./browser/BrowserProfilesManager", () => ({ BrowserProfilesManager: () => null }));
vi.mock("./browser/MoreMenu", () => ({ MoreMenu: () => null }));
vi.mock("./browser/PasskeyNotice", () => ({ PasskeyNotice: () => null }));

const { LiveBrowser } = await import("./BrowserPanel");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  surfaces.length = 0;
  streams.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(LiveBrowser, { bot })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the browser panel on a Cloud that shows the browser's window", () => {
  it("streams without pictures and shows the desktop view once the browser runs, with no first frame ever", async () => {
    const surface = surfaces.at(-1)!;
    surface.connect({ width: 800, height: 600 }, {});
    expect(streams.at(-1)!.query).toMatchObject({ frames: "0" });
    await act(async () => {
      surface.onConnectedChange?.(true);
      surface.onMessage?.({ type: "starting" });
    });
    expect(host.querySelector("[data-stub-desktop]")).toBeNull();
    await act(async () => {
      surface.onControl?.({ controller: "unclaimed", canOperate: true, held: false, owned: false, controlling: false, stale: false, generation: 0, dialog: null });
      surface.onMessage?.({ type: "tabs", tabs: [{ tabId: "t1", title: "Example", url: "https://example.com/", active: true }] });
    });
    expect(host.querySelector("[data-stub-desktop]")).not.toBeNull();
  });
});
