// Density is an occasional preference chosen in Settings → Appearance; the
// sidebar header keeps only its frequent controls (collapse, activity, add),
// and Simple mode keeps only add. The header is one row on the traffic
// lights' line: [lights] [drag space] [server switcher] [buttons].
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
  hostLabel: undefined as string | undefined,
}));

vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.density,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => {
    const capabilities = initialDesktopCapabilities();
    const host = { ...capabilities.host, label: fixture.hostLabel ?? capabilities.host.label };
    return { capabilities: { ...capabilities, host, windowChrome: fixture.windowChrome }, ready: true };
  },
}));

import { MAC_TRAFFIC_LIGHT_CENTER_Y, Sidebar } from "./Sidebar";

const render = () => renderToStaticMarkup(
  createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })),
);

beforeEach(() => {
  fixture.density = "comfortable";
  fixture.advanced = true;
  fixture.windowChrome = undefined;
  fixture.hostLabel = undefined;
  vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("sidebar header", () => {
  it.each(["comfortable", "compact", "icons"] as const)(
    "keeps collapse, activity and add but no density menu at %s density in Advanced mode",
    (density) => {
      fixture.density = density;
      const html = render();
      expect(html).toContain(density === "icons" ? 'aria-label="Expand sidebar"' : 'aria-label="Collapse sidebar to avatars"');
      expect(html).toContain('aria-label="Active Threads"');
      expect(html).toContain('aria-label="New or share"');
      expect(html).not.toContain("Choose sidebar density");
      expect(html).not.toContain('title="Sidebar density"');
    },
  );

  it.each(["comfortable", "compact"] as const)("keeps only add in Simple mode at %s density", (density) => {
    fixture.advanced = false;
    fixture.density = density;
    const html = render();
    expect(html).not.toContain('aria-label="Collapse sidebar to avatars"');
    expect(html).not.toContain('aria-label="Active Threads"');
    expect(html).toContain('aria-label="New or share"');
  });

  it("still offers Expand on an icons rail in Simple mode, so the rail is never a dead end", () => {
    fixture.advanced = false;
    fixture.density = "icons";
    const html = render();
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).not.toContain('aria-label="Active Threads"');
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
  /** The class list of the first element carrying `attribute`. */
  const classesOf = (html: string, attribute: string) => {
    const match = new RegExp(`${attribute}(?:="[^"]*")? class="([^"]*)"`).exec(html);
    expect(match, attribute).not.toBeNull();
    return match![1].split(" ");
  };
  /** Where the lights' space, the slot (drag spacer + switcher), the switcher and the buttons start in the row. */
  const order = (row: string) => ({
    lights: row.indexOf("data-traffic-light-space"),
    slot: row.indexOf("data-sidebar-top-slot"),
    spacer: row.indexOf("data-sidebar-top-spacer"),
    switcher: row.indexOf('data-workspace-switcher="inline"'),
    buttons: row.indexOf("data-sidebar-top-buttons"),
  });

  it.each([true, false])("puts the lights, a drag space, then the compact server switcher beside the buttons on one macOS row (advanced %s)", (advanced) => {
    fixture.advanced = advanced;
    fixture.windowChrome = "mac-inset";
    desktop();
    const html = render();
    const row = topRow(html);
    // Twice the lights' centre line tall, so centred controls share that line.
    expect(MAC_TRAFFIC_LIGHT_CENTER_Y).toBe(23);
    expect(row).toMatch(/^data-sidebar-top-row="true" class="[^"]*\bitems-center\b[^"]*" style="-webkit-app-region:drag;height:46px"/);
    const { lights, slot, spacer, switcher, buttons } = order(row);
    expect(lights).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(lights);
    expect(spacer).toBeGreaterThan(slot);
    expect(switcher).toBeGreaterThan(spacer);
    expect(buttons).toBeGreaterThan(switcher);
    // Simple keeps only "+", so the switcher sits right beside it.
    expect(row.slice(buttons).match(/<button/g)).toHaveLength(advanced ? 3 : 1);
    // 16px in on the left like the lights; 8px on the right, so the last
    // button sits near the sidebar's edge. `relative` anchors the switcher's
    // error note to the row; without it the note drops to the sidebar's foot.
    const rowClasses = classesOf(row, "data-sidebar-top-row");
    expect(rowClasses).toEqual(expect.arrayContaining(["relative", "pl-4", "pr-2"]));
    expect(rowClasses).not.toContain("px-4");
    // The lights end 76px in on macOS 26; their space ends 12px past them,
    // so nothing clickable (nor its hover background) reaches them.
    expect(classesOf(row, "data-traffic-light-space")).toEqual(expect.arrayContaining(["w-[72px]", "shrink-0"]));
    // The slot between the lights and the buttons is the size container the
    // switcher reads. Its spacer is empty (so it stays a drag region) and
    // takes the slack.
    expect(classesOf(row, "data-sidebar-top-slot")).toEqual(expect.arrayContaining(["@container/sidebar-top", "min-w-0", "flex-1"]));
    expect(row).toContain('<div data-sidebar-top-spacer="true" class="min-w-0 flex-1 @min-[96px]/sidebar-top:min-w-6"></div>');
    // The switcher is capped and gives way first; the buttons never shrink.
    const switcherClasses = classesOf(row, "data-sidebar-top-switcher");
    expect(switcherClasses).toEqual(expect.arrayContaining(["min-w-0", "max-w-[140px]"]));
    expect(switcherClasses).not.toContain("flex-1");
    expect(classesOf(row, "data-sidebar-top-buttons")).toEqual(expect.arrayContaining(["shrink-0", "gap-0.5"]));
    // Only the switcher's button opts out of the drag region; it clips
    // rather than spilling onto the buttons in the narrowest rows, and its
    // title and label keep the whole name.
    expect(row).toMatch(/aria-label="Switch server: Servers"[^>]*title="Servers"[^>]*class="[^"]*\bh-7\b[^"]*\boverflow-hidden\b[^"]*\btext-\[12\.5px\][^"]*" style="-webkit-app-region:no-drag"/);
    // A slot narrower than 96px cannot hold icon, a truncated name, and the
    // chevron, so the name hides. Default macOS Advanced leaves about 121px,
    // which still shows the name and keeps a 24px drag gap.
    expect(row).toContain('<span class="min-w-0 truncate @max-[96px]/sidebar-top:hidden">Servers</span>');
    expect(row).toContain("focus-visible:outline-2");
    expect(html).toContain('title="New or share"');
    if (advanced) {
      expect(row).toContain('title="Collapse to avatars"');
      expect(row).toContain('aria-label="Collapse sidebar to avatars"');
      expect(row).toContain('title="Active Threads"');
    } else {
      expect(html).not.toContain('title="Collapse to avatars"');
      expect(html).not.toContain('title="Active Threads"');
    }
    // No second, full-width switcher row beneath the header.
    expect(html.match(/Switch server:/g)).toHaveLength(1);
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

  it("keeps the browser build's placeholder lights 12px clear of the drag space and buttons", () => {
    const row = topRow(render());
    expect(row).toContain('<div class="flex shrink-0 items-center gap-2 mr-3"><span class="size-3 rounded-full bg-[#ff5f57]"></span>');
    const { spacer, buttons } = order(row);
    expect(spacer).toBeGreaterThan(row.indexOf("bg-[#28c840]"));
    expect(buttons).toBeGreaterThan(spacer);
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
    expect(classesOf(row, "data-traffic-light-space")).toEqual(["h-5", "w-full"]);
    expect(classesOf(row, "data-sidebar-top-buttons")).toEqual(["relative", "flex", "shrink-0", "items-center", "flex-col", "gap-1"]);
    expect(html.match(/Switch server:/g)).toHaveLength(1);
  });
});

describe("sidebar glass head and foot", () => {
  it.each(["comfortable", "compact", "icons"] as const)(
    "puts the top row and search in the glass head, the places in the glass foot, and the list between at %s density",
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
      const list = at('class="glass-scroller ');
      const foot = at('data-glass-bar="bottom"');
      const places = at('data-sidebar-nav="routines"');
      expect(head).toBeLessThan(topRow);
      expect(topRow).toBeLessThan(search);
      expect(search).toBeLessThan(list);
      expect(list).toBeLessThan(foot);
      expect(foot).toBeLessThan(places);
      // One frame holds both bars, so the list scrolls under each of them.
      expect(html.match(/data-glass-frame=""/g)).toHaveLength(1);
      expect(at("data-glass-frame")).toBeLessThan(head);
    },
  );
});

describe("sidebar foot in Simple mode", () => {
  it.each(["comfortable", "compact"] as const)("keeps only the profile row, with Apps at its end (%s)", (density) => {
    fixture.advanced = false;
    fixture.density = density;
    const html = render();
    const foot = html.indexOf('data-glass-bar="bottom"');
    expect(html).not.toContain('data-sidebar-nav="routines"');
    expect(html).not.toContain('data-sidebar-nav="triggers"');
    expect(html.match(/data-sidebar-nav="apps"/g)).toHaveLength(1);
    expect(html.indexOf('data-sidebar-nav="apps"')).toBeGreaterThan(foot);
  });

  it("keeps Routines and Triggers in Advanced mode, and still one Apps", () => {
    fixture.advanced = true;
    const html = render();
    expect(html).toContain('data-sidebar-nav="routines"');
    expect(html).toContain('data-sidebar-nav="triggers"');
    expect(html.match(/data-sidebar-nav="apps"/g)).toHaveLength(1);
  });
});
