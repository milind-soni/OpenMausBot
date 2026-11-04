// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdaterState } from "@/types/ogb";

type Place = { local: boolean; name: string; origin?: string; color?: string; home?: boolean; role?: string; localPath?: string };
const fixture = vi.hoisted(() => ({
  windowChrome: "mac-inset" as "mac-inset" | "win-caption" | "native",
  windowFrame: undefined as boolean | undefined,
  rail: { available: true, hidden: false } as { available: boolean; hidden: boolean } | null,
  update: null as UpdaterState | null,
  dispatch: vi.fn(),
  config: {} as { team?: { name: string } },
  look: null as { color: string | null } | null,
  frameDrawn: vi.fn(),
}));
vi.mock("@/lib/chrome-rail", () => ({ useChromeRail: () => fixture.rail, setChromeRailHidden: () => {}, sayFrameDrawn: fixture.frameDrawn }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.update }));
vi.mock("@/lib/place-look", () => ({ usePlaceLook: () => fixture.look }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { windowChrome: fixture.windowChrome, windowFrame: fixture.windowFrame }, ready: true }),
}));

import { setLocale } from "@/lib/i18n";
import { tilesClearCorner } from "./SidebarTiles";
import { UpdateIndicator } from "./UpdateIndicator";
import { WindowFrameBar } from "./WindowFrameBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let place: Place | null;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  fixture.windowChrome = "mac-inset";
  fixture.windowFrame = undefined;
  fixture.rail = { available: true, hidden: false };
  fixture.update = null;
  fixture.config = {};
  fixture.look = null;
  fixture.dispatch.mockClear();
  fixture.frameDrawn.mockClear();
  place = { local: false, name: "My Cloud", origin: "https://cloud.example", color: "blue" };
  Object.assign(window, { ogb: { workspaces: { state: async () => place, onChanged: () => () => {}, menu: async () => {} } } });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); delete (window as { ogb?: unknown }).ogb; });

async function mount(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => root!.render(element));
  await act(async () => { await Promise.resolve(); });
}
const bar = () => host.querySelector<HTMLElement>("[data-window-frame-bar]");
const middle = () => host.querySelector<HTMLElement>("[data-window-place]");

describe("the window frame's top bar", () => {
  it("is drawn on macOS, as thin as the traffic lights allow, and drags the window; its first button starts after the lights", async () => {
    await mount(createElement(WindowFrameBar));
    const classes = bar()!.className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["h-7", "bg-frame", "grid"]));
    expect(bar()!.hasAttribute("data-window-drag"), "the drag region every header marks (window-drag-regions.test.ts)").toBe(true);
    expect(host.querySelector("[data-frame-bar-start]")!.className).toContain("pl-20");
    const buttons = [...bar()!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    expect(buttons, "the rail's button, then the app's settings; no update while there is none").toEqual(["Hide your computers", "App settings"]);
    expect(bar()!.querySelector("[data-rail-toggle]")!.className).toContain("size-[22px]");
  });

  it("spans the window under its rail, so the place it names sits in the window's middle with equal sides", async () => {
    await mount(createElement(WindowFrameBar));
    const classes = bar()!.className.split(" ");
    expect(classes, "out under the rail, as far as the page moved").toContain("ml-[calc(-1*var(--rail-beside,0px))]");
    expect(classes, "three columns: the two sides share what is left equally and never shrink below their buttons; the middle gives way first")
      .toContain("grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)]");
    expect([...bar()!.children].map((child) => child.getAttribute("data-frame-bar-start") !== null ? "start" : child.hasAttribute("data-window-place") ? "place" : "end"))
      .toEqual(["start", "place", "end"]);
  });

  it("names the place on screen in its middle, with its mark, quiet and in one line, and keeps it part of the drag region", async () => {
    await mount(createElement(WindowFrameBar));
    expect(middle()!.textContent).toBe("MCMy Cloud");
    expect(middle()!.className.split(" ")).toEqual(expect.arrayContaining(["text-ink-secondary", "min-w-0"]));
    expect(middle()!.querySelector("span:last-child")!.className).toContain("truncate");
    expect(middle()!.querySelector("[aria-hidden='true']")!.getAttribute("style"), "the rail's tile, small, in the place's colour").toContain("width: 16px; height: 16px");
    expect(middle()!.closest("button, a, [role='button']"), "no control: it drags the window like the rest of the bar").toBeNull();
  });

  it.each([
    [{ local: true, name: "Mac mini" }, {}, "This computer"],
    [{ local: true, name: "Lab", localPath: "/Users/me/lab" }, {}, "Lab"],
    [{ local: false, name: "Saved name", home: true }, {}, "My Cloud"],
    [{ local: false, name: "Acme", role: "Admin" }, { team: { name: "Acme" } }, "Acme"],
    [{ local: false, name: "Office", origin: "https://office.example" }, {}, "Office"],
  ] as const)("names %o as it should", async (shown, config, name) => {
    place = { ...shown };
    fixture.config = config;
    await mount(createElement(WindowFrameBar));
    expect(middle()!.querySelector("span:last-child")!.textContent).toBe(name);
    expect(Boolean(middle()!.querySelector("svg.lucide-laptop")), "This computer's laptop").toBe(shown.local);
  });

  it("names nothing where main says nothing (a browser, a remote client, an older app)", async () => {
    delete (window as { ogb?: unknown }).ogb;
    await mount(createElement(WindowFrameBar));
    expect(middle()).toBeNull();
    expect(bar()!.children).toHaveLength(3);
  });

  it("leaves the caption buttons the right end on Windows, and draws nothing where the window has its own title bar", async () => {
    fixture.windowChrome = "win-caption";
    await mount(createElement(WindowFrameBar));
    expect(host.querySelector("[data-frame-bar-start]")!.className).toContain("pl-[calc(var(--rail-beside,0px)+8px)]");
    expect(host.querySelector("[data-frame-bar-end]")!.className).toContain("pr-[140px]");
    await act(async () => root!.unmount());
    fixture.windowChrome = "native";
    await mount(createElement(WindowFrameBar));
    expect(bar()).toBeNull();
  });

  it("tells main it draws the frame, so the traffic lights move into its bar; a window with its own title bar says nothing", async () => {
    await mount(createElement(WindowFrameBar));
    expect(fixture.frameDrawn).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    fixture.windowChrome = "native";
    await mount(createElement(WindowFrameBar));
    expect(fixture.frameDrawn).toHaveBeenCalledTimes(1);
  });

  it("draws nothing once the person turned the frame off, and tells main it draws none, so the traffic lights go back", async () => {
    fixture.windowFrame = false;
    await mount(createElement(WindowFrameBar));
    expect(bar()).toBeNull();
    expect(fixture.frameDrawn).toHaveBeenLastCalledWith(false);
    fixture.windowFrame = true;
    await act(async () => root!.render(createElement(WindowFrameBar)));
    expect(bar()).not.toBeNull();
    expect(fixture.frameDrawn).toHaveBeenLastCalledWith(true);
  });

  it("opens the app's settings", async () => {
    await mount(createElement(WindowFrameBar));
    await act(async () => bar()!.querySelector<HTMLButtonElement>("[data-frame-settings]")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true });
  });

  it("shows a download arrow in the accent while an update waits, its words in its name, and the sidebar's round buttons step aside for it", async () => {
    fixture.update = { status: "downloading", percent: 45.4 };
    await mount(createElement("div", null, createElement(WindowFrameBar), createElement("aside", null, createElement(UpdateIndicator))));
    const arrow = () => bar()!.querySelector<HTMLButtonElement>("[data-update-indicator]")!;
    expect(arrow().textContent, "an icon, no words on the bar").toBe("");
    expect(arrow().getAttribute("aria-label")).toBe("Downloading an update, 45%");
    expect(arrow().className.split(" ")).toEqual(expect.arrayContaining(["size-[22px]", "text-accent"]));
    expect(arrow().querySelector("svg")!.getAttribute("class"), "it pulses while it downloads").toContain("animate-pulse");
    expect(host.querySelector("aside")!.innerHTML, "one update button in a framed window").toBe("");
    const order = [...bar()!.querySelectorAll("button")].map((button) => button.hasAttribute("data-update-indicator") ? "update" : button.getAttribute("aria-label"));
    expect(order, "before Settings, at the right end").toEqual(["Hide your computers", "update", "App settings"]);
    fixture.update = { status: "downloaded", version: "0.1.136" };
    await act(async () => root!.render(createElement(WindowFrameBar)));
    expect(arrow().getAttribute("aria-label")).toContain("0.1.136");
    expect(arrow().querySelector("svg")!.getAttribute("class")).not.toContain("animate-pulse");
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
