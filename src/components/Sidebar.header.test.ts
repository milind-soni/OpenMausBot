import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialDesktopCapabilities } from "@/lib/desktop";
import { setLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { StoreProvider } from "@/state/store";

const fixture = vi.hoisted(() => ({
  density: "comfortable" as SidebarDensity,
  advanced: true,
  windowChrome: undefined as "mac-inset" | "win-caption" | "native" | undefined,
  windowFrame: undefined as boolean | undefined,
  hostLabel: undefined as string | undefined,
  rail: null as { available: boolean; hidden: boolean } | null,
}));

vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.density,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/chrome-rail", () => ({ useChromeRail: () => fixture.rail, setChromeRailHidden: () => {} }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => {
    const capabilities = initialDesktopCapabilities();
    const host = { ...capabilities.host, label: fixture.hostLabel ?? capabilities.host.label };
    return { capabilities: { ...capabilities, host, windowChrome: fixture.windowChrome, windowFrame: fixture.windowFrame }, ready: true };
  },
}));

import { Sidebar } from "./Sidebar";

const render = () => renderToStaticMarkup(
  createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })),
);

beforeEach(() => {
  fixture.density = "comfortable";
  fixture.advanced = true;
  fixture.windowChrome = undefined;
  fixture.windowFrame = undefined;
  fixture.hostLabel = undefined;
  fixture.rail = null;
  vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("sidebar header", () => {
  const collapse = /aria-label="(Collapse sidebar to avatars|Expand sidebar)"|data-sidebar-edge-toggle/;

  it.each(["comfortable", "icons"] as const)("keeps activity and add, and no button collapses or expands it, at %s density in Advanced mode", (density) => {
    fixture.density = density;
    const html = render();
    expect(html).toContain('aria-label="Active Threads"');
    expect(html).toContain('aria-label="New or share"');
    expect(html).not.toMatch(collapse);
  });

  it.each(["comfortable", "icons"] as const)("keeps add, no activity menu and no collapse button in Simple mode at %s density: its edge is dragged instead", (density) => {
    fixture.advanced = false;
    fixture.density = density;
    const html = render();
    expect(html).not.toContain('aria-label="Active Threads"');
    expect(html).toContain('aria-label="New or share"');
    expect(html).not.toMatch(collapse);
    expect(html, "the edge that is dragged, open or as avatars, so the avatars are never a dead end").toMatch(/role="separator" aria-label="Resize sidebar"/);
  });
});

describe("sidebar top row", () => {
  const desktop = () => vi.stubGlobal("window", {
    innerWidth: 1280,
    location: { protocol: "http:", search: "" },
    ogb: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } },
  });
  const topRow = (html: string) => {
    const start = html.indexOf("data-sidebar-top-row");
    const end = html.indexOf('aria-label="New or share"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
  };
  const classesOf = (html: string, attribute: string) => {
    const match = new RegExp(`${attribute}(?:="[^"]*")? class="([^"]*)"`).exec(html);
    expect(match, attribute).not.toBeNull();
    return match![1].split(" ");
  };
  const order = (row: string) => ({
    lights: row.indexOf("data-traffic-light-space"),
    slot: row.indexOf("data-sidebar-top-slot"),
    spacer: row.indexOf("data-sidebar-top-spacer"),
    switcher: row.indexOf('data-workspace-switcher="inline"'),
    buttons: row.indexOf("data-sidebar-top-buttons"),
  });

  it("leaves the traffic lights to the window frame's top bar on macOS: a drag space, then the compact server switcher beside the buttons in Advanced mode", () => {
    fixture.windowChrome = "mac-inset";
    desktop();
    const html = render();
    const row = topRow(html);
    expect(row).toMatch(/^data-sidebar-top-row="true" class="[^"]*\bitems-center\b[^"]*\bh-12\b[^"]*" style="-webkit-app-region:drag"/);
    const { lights, slot, spacer, switcher, buttons } = order(row);
    expect(lights).toBe(-1);
    expect(slot).toBeGreaterThan(-1);
    expect(spacer).toBeGreaterThan(slot);
    expect(switcher).toBeGreaterThan(spacer);
    expect(buttons).toBeGreaterThan(switcher);
    expect(row.slice(buttons).match(/<button/g)).toHaveLength(2);
    const rowClasses = classesOf(row, "data-sidebar-top-row");
    expect(rowClasses).toEqual(expect.arrayContaining(["relative", "pl-4", "pr-2"]));
    expect(rowClasses).not.toContain("px-4");
    expect(classesOf(row, "data-sidebar-top-slot")).toEqual(expect.arrayContaining(["@container/sidebar-top", "min-w-0", "flex-1"]));
    expect(row).toContain('<div data-sidebar-top-spacer="true" class="min-w-0 flex-1 @min-[96px]/sidebar-top:min-w-6"></div>');
    const switcherClasses = classesOf(row, "data-sidebar-top-switcher");
    expect(switcherClasses).toEqual(expect.arrayContaining(["min-w-0", "max-w-[140px]"]));
    expect(switcherClasses).not.toContain("flex-1");
    expect(classesOf(row, "data-sidebar-top-buttons")).toEqual(expect.arrayContaining(["shrink-0", "gap-0.5"]));
    expect(row).toMatch(/aria-label="Switch server: Servers"[^>]*title="Servers"[^>]*class="[^"]*\bh-7\b[^"]*\boverflow-hidden\b[^"]*\btext-\[13px\][^"]*" style="-webkit-app-region:no-drag"/);
    expect(row).toContain('<span class="min-w-0 truncate @max-[96px]/sidebar-top:hidden">Servers</span>');
    expect(row).toContain("focus-visible:outline-2");
    expect(html).toContain('title="New or share"');
    expect(row).toContain('title="Active Threads"');
    expect(html.match(/Switch server:/g)).toHaveLength(1);
  });

  it.each(["mac-inset", "win-caption"] as const)("in Simple mode on %s keeps only the top corner: plain search and + at its right end, no drag region, no server pill, nothing on the edge", (windowChrome) => {
    fixture.advanced = false;
    fixture.windowChrome = windowChrome;
    desktop();
    const html = render();
    const row = topRow(html);
    expect(row, "the bot tiles rise into the rest of the corner: no drag region, no clicks but the buttons'").toMatch(/^data-sidebar-top-row="corner" class="[^"]*\bpointer-events-none\b[^"]*\bh-\[34px\][^"]*\bitems-start\b[^"]*">/);
    expect(classesOf(row, "data-sidebar-top-row")).toEqual(expect.arrayContaining(["justify-end", "px-1.5", "pt-1.5"]));
    expect(row).not.toContain("data-workspace-switcher");
    expect(html).not.toContain("Switch server:");
    const { lights, slot, buttons } = order(row);
    expect(lights).toBe(-1);
    expect(buttons).toBeGreaterThan(slot);
    expect(classesOf(row, "data-sidebar-top-buttons")).toEqual(expect.arrayContaining(["shrink-0", "pointer-events-auto"]));
    expect(row.slice(buttons).match(/<button/g)).toHaveLength(2);
    expect(row).toMatch(/data-sidebar-search-toggle="true" aria-label="Search bots and messages" aria-expanded="false" title="Search bots and messages" class="[^"]*\bsize-\[26px\][^"]*\brounded-lg\b[^"]*\btext-ink-secondary\b/);
    expect(row, "no round box round either").not.toContain("bg-composer");
    expect(html).toMatch(/aria-label="New or share" class="[^"]*\bsize-\[26px\][^"]*\brounded-lg\b/);
    expect(html).not.toContain("data-sidebar-edge-toggle");
    expect(html).not.toContain('title="Active Threads"');
    expect(html).not.toContain("data-sidebar-search-pill");
  });

  it.each([["win-caption", "Windows"], ["native", "Linux"]] as const)(
    "keeps the same right-aligned order without traffic lights (%s)",
    (windowChrome, hostLabel) => {
      fixture.windowChrome = windowChrome;
      fixture.hostLabel = hostLabel;
      desktop();
      const html = render();
      const row = topRow(html);
      expect(row).not.toContain("data-traffic-light-space");
      expect(row).not.toContain("bg-[#ff5f57]");
      expect(classesOf(row, "data-sidebar-top-row")).toEqual(expect.arrayContaining(["relative", "h-12", "pl-4", "pr-2"]));
      const { slot, spacer, switcher, buttons } = order(row);
      expect(slot).toBeGreaterThan(-1);
      expect(spacer).toBeGreaterThan(slot);
      expect(switcher).toBeGreaterThan(spacer);
      expect(buttons).toBeGreaterThan(switcher);
      expect(html.match(/Switch server:/g)).toHaveLength(1);
    },
  );

  it("with the frame turned off on macOS, makes room for the traffic lights in its corner again, the rail's button after them", () => {
    fixture.windowChrome = "mac-inset";
    fixture.windowFrame = false;
    fixture.rail = { available: true, hidden: false };
    desktop();
    const advanced = topRow(render());
    expect(advanced).toMatch(/^data-sidebar-top-row="true" class="[^"]*" style="-webkit-app-region:drag;height:46px"/);
    expect(classesOf(advanced, "data-traffic-light-space")).toEqual(["w-[72px]", "shrink-0", "md:w-[calc(72px_-_var(--rail-beside,0px))]"]);
    expect(advanced.indexOf("data-traffic-light-space")).toBeLessThan(advanced.indexOf("data-rail-toggle"));
    fixture.advanced = false;
    const simple = topRow(render());
    expect(simple, "Simple keeps its own top row, not the frame's corner").toMatch(/^data-sidebar-top-row="true"/);
    expect(simple.indexOf("data-traffic-light-space")).toBeLessThan(simple.indexOf("data-rail-toggle"));
    fixture.density = "icons";
    expect(classesOf(render(), "data-traffic-light-space"), "the column of avatars keeps a strip above for them").toEqual(["h-5", "w-full"]);
  });

  it("with the frame turned off on Windows, its own title bar is back: nothing makes room and nothing drags", () => {
    fixture.windowChrome = "native";
    fixture.windowFrame = false;
    fixture.hostLabel = "Windows";
    desktop();
    const row = topRow(render());
    expect(row).not.toContain("data-traffic-light-space");
    expect(row).not.toContain("app-region:drag");
  });

  it("draws no window buttons in a browser, where the browser has its own", () => {
    const row = topRow(render());
    expect(row).not.toContain("bg-[#ff5f57]");
    expect(row).not.toContain("data-traffic-light-space");
    const { spacer, buttons } = order(row);
    expect(buttons).toBeGreaterThan(spacer);
  });

  it("collapses Simple mode to a rail: round search and + on top (the frame's top bar holds the lights), nothing on the edge, and Apps and the account at the foot", () => {
    fixture.advanced = false;
    fixture.density = "icons";
    fixture.windowChrome = "mac-inset";
    desktop();
    const html = render();
    const top = html.slice(html.indexOf("data-sidebar-top-row"), html.indexOf("data-sidebar-rail-footer"));
    expect(top).not.toContain("data-traffic-light-space");
    expect(top).not.toContain("data-sidebar-top-buttons");
    expect(top).not.toContain("data-workspace-switcher");
    expect(top.indexOf('aria-label="Search bots and messages"')).toBeLessThan(top.indexOf('aria-label="New or share"'));
    expect(top).toMatch(/data-sidebar-rail-top="true" class="flex flex-col items-center gap-2 pt-1"/);
    expect(top).toMatch(/aria-label="New or share" class="[^"]*\bsize-9\b[^"]*\brounded-full\b/);
    const foot = html.slice(html.indexOf("data-sidebar-rail-footer"));
    const at = (marker: string) => {
      const index = foot.indexOf(marker);
      expect(index, marker).toBeGreaterThan(-1);
      return index;
    };
    expect(html).not.toContain("data-sidebar-edge-toggle");
    expect(foot).not.toContain('aria-label="Search bots and messages"');
    const positions = [
      at('data-sidebar-nav="apps"'),
      at("data-sidebar-account"),
    ];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(foot).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"[^>]*aria-label="Connect apps"[^>]*class="[^"]*\bsize-9\b[^"]*"><svg[^>]*lucide-puzzle/);
    expect(foot).not.toContain("data-workspace-switcher");
    expect(foot).not.toContain('data-sidebar-nav="automations"');
    expect(foot).not.toContain('data-sidebar-nav="team-map"');
    expect(html).not.toContain("Switch server:");
    expect(html.match(/aria-label="New or share"/g)).toHaveLength(1);
  });

  it("stacks the icons rail unchanged and keeps the icon-only switcher beneath it", () => {
    fixture.density = "icons";
    fixture.windowChrome = "mac-inset";
    desktop();
    const html = render();
    const row = topRow(html);
    expect(row).not.toContain("data-workspace-switcher");
    expect(row).not.toContain("data-sidebar-top-spacer");
    expect(classesOf(row, "data-sidebar-top-row")).toEqual(["flex", "items-center", "flex-col", "gap-1", "px-2", "pt-3.5", "pb-1"]);
    expect(row).not.toContain("data-traffic-light-space");
    expect(classesOf(row, "data-sidebar-top-buttons")).toEqual(["relative", "flex", "shrink-0", "items-center", "flex-col", "gap-1"]);
    expect(html.match(/Switch server:/g)).toHaveLength(1);
  });
});

describe("the button that hides and shows the window's rail of places", () => {
  const row = () => {
    const html = render();
    return html.slice(html.indexOf("data-sidebar-top-row"), html.indexOf('aria-label="New or share"'));
  };
  const toggle = (html: string) => /<button type="button" data-rail-toggle="true"[^>]*>/.exec(html)?.[0] ?? "";
  beforeEach(() => {
    vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" }, ogb: { workspaces: { state: () => new Promise(() => {}), menu: () => Promise.resolve() } } });
    fixture.windowChrome = "mac-inset";
    fixture.rail = { available: true, hidden: false };
  });

  it("moves to the window frame's top bar on macOS and Windows: no row of the sidebar holds it", () => {
    for (const windowChrome of ["mac-inset", "win-caption"] as const) {
      fixture.windowChrome = windowChrome;
      for (const [advanced, density] of [[true, "comfortable"], [false, "comfortable"], [true, "icons"], [false, "icons"]] as const) {
        fixture.advanced = advanced;
        fixture.density = density;
        expect(render(), `${windowChrome}, ${advanced ? "Advanced" : "Simple"}, ${density}`).not.toContain("data-rail-toggle");
      }
    }
  });

  it("leads the row on Linux, round like the row's other buttons, its words saying what a click does", () => {
    fixture.windowChrome = "native";
    fixture.hostLabel = "Linux";
    const advanced = row();
    expect(advanced.indexOf("data-rail-toggle")).toBeGreaterThan(-1);
    expect(advanced.indexOf("data-rail-toggle")).toBeLessThan(advanced.indexOf("data-sidebar-top-slot"));
    expect(toggle(advanced)).toMatch(/aria-label="Hide your computers" title="Hide your computers" aria-expanded="true" class="[^"]*\bsize-8\b[^"]*\brounded-full\b/);
    expect(advanced).toMatch(/data-rail-toggle="true"[^>]*><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect[^>]*><\/rect><path d="M9 3v18"><\/path>(<circle[^>]*fill="currentColor"><\/circle>){3}<\/svg>/);
    fixture.advanced = false;
    const simple = row();
    expect(simple.indexOf("data-rail-toggle")).toBeLessThan(simple.indexOf("data-sidebar-top-slot"));
    expect(toggle(simple)).toMatch(/class="[^"]*\bsize-9\b[^"]*\brounded-full\b[^"]*\bbg-composer\b/);
    expect(toggle(simple), "the rail is shown most of the time: no open-menu tint for it").not.toContain("aria-expanded:bg-");
    fixture.rail = { available: true, hidden: true };
    expect(toggle(row())).toContain('aria-label="Show your computers" title="Show your computers" aria-expanded="false"');
  });

  it("tops the column of buttons on Linux when the sidebar shows only avatars", () => {
    fixture.windowChrome = "native";
    fixture.density = "icons";
    const column = render();
    expect(column.indexOf("data-rail-toggle")).toBeGreaterThan(-1);
    expect(column.indexOf("data-rail-toggle")).toBeLessThan(column.indexOf("data-sidebar-top-buttons"));
    expect(toggle(column)).toMatch(/class="[^"]*\bsize-\[46px\][^"]*\brounded-xl\b/);
    fixture.advanced = false;
    const rail = render();
    expect(rail.indexOf("data-rail-toggle")).toBeLessThan(rail.indexOf("data-sidebar-rail-top"));
    expect(toggle(rail)).toMatch(/class="[^"]*\bsize-9\b[^"]*\brounded-full\b/);
  });

  it("is nowhere without a rail to hide: one place, a browser, an older app, or a page that isn't beside it", () => {
    for (const rail of [null, { available: false, hidden: false }, { available: false, hidden: true }]) {
      fixture.rail = rail;
      expect(render()).not.toContain("data-rail-toggle");
    }
  });
});

describe("sidebar head and foot", () => {
  it.each(["comfortable", "icons"] as const)(
    "puts the top row and search in the head, the places in the foot, and the fading list between at %s density",
    (density) => {
      fixture.density = density;
      const html = render();
      const at = (marker: string) => {
        const index = html.indexOf(marker);
        expect(index, marker).toBeGreaterThan(-1);
        return index;
      };
      const head = at('data-glass-bar="top"');
      const topRow = at("data-sidebar-top-row");
      const search = at('aria-label="Search bots and messages"');
      const list = at('data-scroll-fade-frame=""');
      const foot = at('data-glass-bar="bottom"');
      const automations = at('data-sidebar-nav="automations"');
      const places = at('data-sidebar-nav="team-map"');
      expect(head).toBeLessThan(topRow);
      expect(topRow).toBeLessThan(search);
      expect(search).toBeLessThan(list);
      expect(list).toBeLessThan(foot);
      expect(foot).toBeLessThan(automations);
      expect(automations).toBeLessThan(places);
      expect(html.match(/data-sidebar-nav="automations"/g)).toHaveLength(1);
      expect(html.match(/data-glass-frame=""/g)).toHaveLength(1);
      expect(at("data-glass-frame")).toBeLessThan(head);
    },
  );
});

describe("sidebar foot in Simple mode", () => {
  it("puts the account avatar then the Connect apps pill in the foot, with Automations and Team map in the account menu", () => {
    fixture.advanced = false;
    const html = render();
    const foot = html.slice(html.indexOf('data-glass-bar="bottom"'));
    expect(foot).toContain('data-sidebar-footer="simple"');
    expect(html).not.toContain('data-sidebar-nav="automations"');
    expect(html).not.toContain('data-sidebar-nav="team-map"');
    expect(html.match(/data-sidebar-nav="apps"/g)).toHaveLength(1);
    expect(foot.indexOf("data-sidebar-account")).toBeGreaterThan(-1);
    expect(foot.indexOf("data-sidebar-account")).toBeLessThan(foot.indexOf('data-sidebar-nav="apps"'));
    expect(foot).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"[^>]*>(<[^>]*>)*Connect apps</);
    expect(foot.match(/data-app-face="/g)).toHaveLength(3);
  });

  it("keeps one Automations row in the foot and no Routines row in Advanced mode, and still one Apps", () => {
    fixture.advanced = true;
    const html = render();
    expect(html).not.toContain('data-sidebar-nav="routines"');
    expect(html.match(/data-sidebar-nav="automations"/g)).toHaveLength(1);
    expect(html.indexOf('data-sidebar-nav="automations"')).toBeGreaterThan(html.indexOf('data-glass-bar="bottom"'));
    expect(html.match(/data-sidebar-nav="apps"/g)).toHaveLength(1);
  });
});
