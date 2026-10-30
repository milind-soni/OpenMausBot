// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdaterState } from "@/types/ogb";

const fixture = vi.hoisted(() => ({
  windowChrome: "mac-inset" as "mac-inset" | "win-caption" | "native",
  rail: { available: true, hidden: false } as { available: boolean; hidden: boolean } | null,
  update: null as UpdaterState | null,
  dispatch: vi.fn(),
}));
vi.mock("@/lib/chrome-rail", () => ({ useChromeRail: () => fixture.rail, setChromeRailHidden: () => {} }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.update }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: fixture.dispatch }) }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { windowChrome: fixture.windowChrome }, ready: true }),
}));

import { setLocale } from "@/lib/i18n";
import { tilesClearCorner } from "./SidebarTiles";
import { UpdateIndicator } from "./UpdateIndicator";
import { WindowFrameBar } from "./WindowFrameBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  fixture.windowChrome = "mac-inset";
  fixture.rail = { available: true, hidden: false };
  fixture.update = null;
  fixture.dispatch.mockClear();
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

async function mount(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => root!.render(element));
}
const bar = () => host.querySelector<HTMLElement>("[data-window-frame-bar]");

describe("the window frame's top bar", () => {
  it("is drawn on macOS, as thin as the traffic lights allow, and drags the window; its first button starts after the lights", async () => {
    await mount(createElement(WindowFrameBar));
    const classes = bar()!.className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["h-7", "bg-frame", "pl-[calc(80px_-_var(--rail-beside,0px))]"]));
    expect(bar()!.hasAttribute("data-window-drag"), "the drag region every header marks (window-drag-regions.test.ts)").toBe(true);
    const buttons = [...bar()!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    expect(buttons, "the rail's button, then the app's settings; no update while there is none").toEqual(["Hide your computers", "App settings"]);
    expect(bar()!.querySelector("[data-rail-toggle]")!.className).toContain("size-[22px]");
  });

  it("leaves the caption buttons the right end on Windows, and draws nothing where the window has its own title bar", async () => {
    fixture.windowChrome = "win-caption";
    await mount(createElement(WindowFrameBar));
    expect(bar()!.className.split(" ")).toEqual(expect.arrayContaining(["pl-2", "pr-[140px]"]));
    await act(async () => root!.unmount());
    fixture.windowChrome = "native";
    await mount(createElement(WindowFrameBar));
    expect(bar()).toBeNull();
  });

  it("opens the app's settings", async () => {
    await mount(createElement(WindowFrameBar));
    await act(async () => bar()!.querySelector<HTMLButtonElement>("[data-frame-settings]")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true });
  });

  it("holds the update in short words while there is one, and the sidebar's round buttons step aside for it", async () => {
    fixture.update = { status: "downloading", percent: 45.4 };
    await mount(createElement("div", null, createElement(WindowFrameBar), createElement("aside", null, createElement(UpdateIndicator))));
    expect(bar()!.querySelector("[data-update-indicator]")!.textContent).toBe("Downloading 45%");
    expect(host.querySelector("aside")!.innerHTML, "one update button in a framed window").toBe("");
    fixture.update = { status: "downloaded", version: "0.1.134" };
    await act(async () => root!.render(createElement(WindowFrameBar)));
    const pill = bar()!.querySelector("[data-update-indicator='downloaded']")!;
    expect(pill.textContent).toBe("Restart to update");
    expect(pill.getAttribute("title"), "its title keeps the long words").toContain("0.1.134");
    fixture.windowChrome = "native";
    await act(async () => root!.render(createElement(UpdateIndicator)));
    expect(host.querySelector("[data-update-indicator='downloaded']"), "unframed, the sidebar keeps its own").not.toBeNull();
  });
});

describe("Simple's sidebar corner", () => {
  // A 280px sidebar: 78px tiles 4px apart, centred, the grid's right edge at 280.
  const row = (count: number, top = 10) => {
    const width = count * 82 - 4, left = (280 - width) / 2;
    return Array.from({ length: count }, (_, index) => ({ top, right: left + index * 82 + 78 }));
  };

  it("lets the tiles rise beside Search and New only while their first row ends before them", () => {
    expect(tilesClearCorner(row(1), 280)).toBe(true);
    expect(tilesClearCorner(row(2), 280)).toBe(true);
    expect(tilesClearCorner(row(3), 280)).toBe(false);
    expect(tilesClearCorner([...row(2), ...row(1, 106)], 280), "a second row under it changes nothing").toBe(true);
    expect(tilesClearCorner(row(2), 240), "a narrower sidebar").toBe(false);
    expect(tilesClearCorner([], 280)).toBe(false);
  });
});
