import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { StoreProvider } from "@/state/store";

const fixture = vi.hoisted(() => ({ density: "comfortable" as SidebarDensity, advanced: true, phone: false }));

vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.density,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-media-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/use-media-query")>(),
  useMediaQuery: () => fixture.phone,
}));

import { Sidebar } from "./Sidebar";
import { SidebarActionsRow } from "./SidebarActionsRow";

const render = () => renderToStaticMarkup(
  createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })),
);

beforeEach(() => {
  fixture.density = "comfortable";
  fixture.advanced = true;
  fixture.phone = false;
  vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" } });
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("sidebar actions row", () => {
  it("shows under the Inbox in Advanced on desktop, with the Collapse all toggle", () => {
    const html = render();
    expect(html).toContain("data-sidebar-actions");
    expect(html).toContain('aria-label="Collapse all"');
    expect(html.indexOf('aria-label="Inbox"')).toBeLessThan(html.indexOf("data-sidebar-actions"));
  });

  it.each([
    ["Simple mode", () => { fixture.advanced = false; }],
    ["the icons density", () => { fixture.density = "icons"; }],
    ["a phone", () => { fixture.phone = true; }],
  ])("is absent in %s", (_name, setup) => {
    setup();
    expect(render()).not.toContain("data-sidebar-actions");
  });

  it("offers Expand all once collapsed, and disables the toggle while a search has text", () => {
    const row = (collapsedAll: boolean, searching: boolean) => renderToStaticMarkup(createElement(SidebarActionsRow, { collapsedAll, searching, onToggleCollapsedAll: () => {} }));
    expect(row(true, false)).toContain('aria-label="Expand all"');
    expect(row(false, false)).not.toMatch(/<button[^>]* disabled=""/);
    expect(row(false, true)).toMatch(/<button[^>]* disabled=""/);
  });
});
