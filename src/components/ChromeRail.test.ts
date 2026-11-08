// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

it("the window's own rail wears the skin of the page beside it, never keeping it as its own choice", async () => {
  let skinOf: (skin: string) => void = () => {};
  const places = { places: [{ id: "local", name: "This computer", color: null, kind: "computer", opens: true, active: true }, { id: "vps", name: "Office", color: null, kind: "server", opens: true }],
    add: { cloud: false, link: true, address: false } };
  const applySkin = vi.fn(async () => true);
  Object.assign(window, { ogb: { applySkin, workspaces: { places: vi.fn(async () => places), open: vi.fn(), add: vi.fn(), onChanged: () => () => {} },
    rail: { expand: vi.fn(async () => {}), onSkin: (callback: (skin: string) => void) => { skinOf = callback; return () => {}; } } } });
  const { ChromeRail } = await import("./ChromeRail");
  const { refreshPlaces } = await import("@/lib/places");
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { await refreshPlaces(); root!.render(createElement(ChromeRail)); });
  await act(async () => { await Promise.resolve(); });
  expect(host.querySelectorAll("[data-rail-place]")).toHaveLength(2);
  act(() => skinOf("midnight"));
  expect(document.documentElement.dataset.skin).toBe("midnight");
  act(() => skinOf("<b>"));
  expect(document.documentElement.dataset.skin).toBe("midnight");
  expect(applySkin, "the page's choice, never sent back to main as this one's").not.toHaveBeenCalled();
});

it("with nothing picked, the rail reads in the language the window beside it shows, as main's menus do", async () => {
  vi.resetModules();
  let windowShows: string | null = "pt-br";
  const told = new Set<(language: string | null) => void>();
  const places = { places: [{ id: "local", name: "This computer", color: null, kind: "computer", opens: true, active: true }], add: { cloud: false, link: true, address: false } };
  Object.assign(window, { ogb: { applySkin: vi.fn(async () => true), workspaces: { places: vi.fn(async () => places), open: vi.fn(), add: vi.fn(), onChanged: () => () => {} },
    rail: { expand: vi.fn(async () => {}), onSkin: () => () => {} },
    desktopLanguage: { choice: () => null, set: vi.fn(async () => true), onChange: () => () => {}, shown: vi.fn(), windowShows: () => windowShows,
      onWindowShows: (listener: (language: string | null) => void) => { told.add(listener); return () => told.delete(listener); } } } });
  const { ChromeRail } = await import("./ChromeRail");
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ChromeRail)); });
  await vi.waitFor(() => expect(document.documentElement.lang).toBe("pt-BR"));
  windowShows = "en";
  act(() => { for (const listener of told) listener("en"); });
  await vi.waitFor(() => expect(document.documentElement.lang).toBe("en"));
  expect((window as unknown as { ogb: { desktopLanguage: { shown: unknown } } }).ogb.desktopLanguage.shown, "the rail never leads").not.toHaveBeenCalled();
});
