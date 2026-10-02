// Density is an occasional preference chosen in Settings → Appearance; the
// sidebar header keeps only its frequent controls (collapse, activity, add),
// and Simple mode keeps only add. The header is one row on the traffic
// lights' line: [lights] [server switcher] [drag space] [buttons].
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
  windowChrome: undefined as "mac-inset" | "win-caption" | undefined,
}));

vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.density,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { ...initialDesktopCapabilities(), windowChrome: fixture.windowChrome }, ready: true }),
}));

import { MAC_TRAFFIC_LIGHT_CENTER_Y, Sidebar } from "./Sidebar";

const render = () => renderToStaticMarkup(
  createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })),
);

beforeEach(() => {
  fixture.density = "comfortable";
  fixture.advanced = true;
  fixture.windowChrome = undefined;
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

  it.each([true, false])("puts the lights, a compact server switcher and the buttons on one macOS row (advanced %s)", (advanced) => {
    fixture.advanced = advanced;
    fixture.windowChrome = "mac-inset";
    desktop();
    const html = render();
    const row = topRow(html);
    // Twice the lights' centre line tall, so centred controls share that line.
    expect(MAC_TRAFFIC_LIGHT_CENTER_Y).toBe(23);
    expect(row).toMatch(/^data-sidebar-top-row="true" class="[^"]*\bitems-center\b[^"]*" style="-webkit-app-region:drag;height:46px"/);
    const lights = row.indexOf("data-traffic-light-space");
    const switcher = row.indexOf('data-workspace-switcher="inline"');
    expect(lights).toBeGreaterThan(-1);
    expect(switcher).toBeGreaterThan(lights);
    // The spacer stays a drag region; only the switcher's button opts out.
    expect(row).toMatch(/data-sidebar-top-switcher="true" class="[^"]*\bflex-1\b[^"]*\bmin-w-0\b|data-sidebar-top-switcher="true" class="[^"]*\bmin-w-0\b[^"]*\bflex-1\b/);
    expect(row).toMatch(/aria-label="Switch server: Servers"[^>]*class="[^"]*\bh-7\b[^"]*\btext-\[12\.5px\][^"]*" style="-webkit-app-region:no-drag"/);
    expect(row).toContain('<span class="min-w-0 truncate">Servers</span>');
    // No second, full-width switcher row beneath the header.
    expect(html.match(/Switch server:/g)).toHaveLength(1);
  });

  it("keeps sensible spacing without traffic lights (Windows/Linux)", () => {
    fixture.windowChrome = "win-caption";
    desktop();
    const html = render();
    const row = topRow(html);
    expect(row).not.toContain("data-traffic-light-space");
    expect(row).toMatch(/^data-sidebar-top-row="true" class="[^"]*\bh-12\b[^"]*\bpx-4\b|^data-sidebar-top-row="true" class="[^"]*\bpx-4\b[^"]*\bh-12\b/);
    expect(row).toContain('data-workspace-switcher="inline"');
    expect(html.match(/Switch server:/g)).toHaveLength(1);
  });

  it("stacks the icons rail and keeps the icon-only switcher beneath it", () => {
    fixture.density = "icons";
    fixture.windowChrome = "mac-inset";
    desktop();
    const html = render();
    expect(topRow(html)).not.toContain("data-workspace-switcher");
    expect(html.match(/Switch server:/g)).toHaveLength(1);
  });
});
