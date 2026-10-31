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

it("rings the part a tour on the page beside it points at and shades the rest; the whole rail for a step on the page; never over a sheet of its own", async () => {
  let markOf: (part: string | null) => void = () => {};
  const places = { places: [{ id: "local", name: "This computer", color: null, kind: "computer", opens: true, active: true }, { id: "vps", name: "Office", color: null, kind: "server", opens: true }],
    add: { cloud: true, link: true, address: false } };
  Object.assign(window, { ogb: { applySkin: vi.fn(async () => true), workspaces: { places: vi.fn(async () => places), open: vi.fn(), add: vi.fn(), onChanged: () => () => {} },
    cloudAdd: { state: vi.fn(async () => ({ signedIn: false })), sheet: vi.fn(async () => {}) },
    rail: { expand: vi.fn(async () => {}), onSkin: () => () => {}, onMark: (callback: (part: string | null) => void) => { markOf = callback; return () => {}; } } } });
  const boxes: Record<string, { left: number; top: number; width: number; height: number }> = { "rail-places": { left: 6, top: 40, width: 24, height: 56 }, "rail-add": { left: 6, top: 104, width: 24, height: 24 } };
  const boxOf = (element: HTMLElement) => boxes[element.dataset.tour ?? ""];
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) { return (boxOf(this) ? [boxOf(this)] : []) as unknown as DOMRectList; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const at = boxOf(this) ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...at, x: at.left, y: at.top, right: at.left + at.width, bottom: at.top + at.height, toJSON: () => at } as DOMRect;
  });
  const { ChromeRail } = await import("./ChromeRail");
  const { refreshPlaces } = await import("@/lib/places");
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { await refreshPlaces(); root!.render(createElement(ChromeRail)); });
  const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 40)); });
  const shade = () => document.querySelector("[data-spotlight-shade]");
  const ring = () => shade()?.querySelector<HTMLElement>(".ring-accent") ?? null;
  await settle();
  expect(shade(), "no tour, no shade").toBeNull();
  act(() => markOf("add")); await settle();
  expect([ring()?.style.left, ring()?.style.top, ring()?.style.width, ring()?.style.height], "the ring round ＋, inside the rail's edges").toEqual(["3px", "101px", "30px", "30px"]);
  act(() => markOf("places")); await settle();
  expect([ring()?.style.top, ring()?.style.height]).toEqual(["37px", "62px"]);
  act(() => markOf("dim")); await settle();
  expect(shade(), "a step on the page beside it: the whole rail shaded").not.toBeNull();
  expect(ring()).toBeNull();
  act(() => markOf("<script>")); await settle();
  expect(shade(), "anything but a part clears it").toBeNull();
  act(() => markOf("add")); await settle();
  await act(async () => { host.querySelector<HTMLElement>("[data-rail-add]")!.click(); });
  expect(shade(), "never over ＋'s own sheet").toBeNull();
  vi.restoreAllMocks();
});
