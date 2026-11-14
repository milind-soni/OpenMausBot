// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ platform: "darwin" as "darwin" | "win32" | "linux" }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: fixture.platform } }, ready: true }),
}));

import { setLocale } from "@/lib/i18n";
import { WindowFrameRow } from "./WindowFrameRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let saved: { on: boolean; restart: boolean };
const set = vi.fn(async (on: boolean) => { saved = { on, restart: fixture.platform === "win32" }; return saved; });
const relaunch = vi.fn(async () => true);

beforeEach(() => {
  setLocale("en");
  fixture.platform = "darwin";
  saved = { on: true, restart: false };
  set.mockClear(); relaunch.mockClear();
  Object.assign(window, { ogb: { windowFrame: { state: async () => saved, set }, relaunch } });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); delete (window as { ogb?: unknown }).ogb; });

async function mount() {
  root = createRoot(host);
  await act(async () => root!.render(createElement(WindowFrameRow)));
  await act(async () => { await Promise.resolve(); });
}
const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="Window frame"]');
const note = () => host.querySelector("[data-window-frame-restart]");

describe("Settings' switch for the window's frame", () => {
  it("is on by default on macOS and turns the frame off at once, with nothing to restart", async () => {
    await mount();
    expect(host.textContent).toContain("Window frame");
    expect(host.textContent).toContain("A thin bar across the top that says where you are");
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => { toggle()!.click(); await Promise.resolve(); });
    expect(set).toHaveBeenCalledWith(false);
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(note(), "macOS moves its traffic lights at once").toBeNull();
  });

  it("on Windows says the change waits for the app to start again, with Restart now where this page may restart it", async () => {
    fixture.platform = "win32";
    await mount();
    await act(async () => { toggle()!.click(); await Promise.resolve(); });
    expect(note()?.textContent).toContain("Takes effect when");
    expect(note()?.textContent).toContain("restarts.");
    await act(async () => { note()!.querySelector("button")!.click(); });
    expect(relaunch).toHaveBeenCalledOnce();
    await act(async () => root!.unmount());
    Object.assign(window, { ogb: { windowFrame: { state: async () => saved, set } } });
    await mount();
    expect(note()?.textContent, "a server's page can't restart the app: the note alone").toContain("Takes effect when");
    expect(note()?.querySelector("button")).toBeNull();
  });

  it("is nowhere a window has its own title bar for good: Linux, a browser, or an older app", async () => {
    fixture.platform = "linux";
    await mount();
    expect(toggle()).toBeNull();
    await act(async () => root!.unmount());
    fixture.platform = "darwin";
    delete (window as { ogb?: unknown }).ogb;
    await mount();
    expect(toggle()).toBeNull();
  });
});
