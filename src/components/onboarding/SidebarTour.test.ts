// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import { readingTimeMs, sidebarTourPlan, type RailWhere, type SidebarTourStep } from "@/lib/sidebar-tour";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
const { SidebarTour } = await import("./SidebarTour");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Where each tour target is on screen; a target that isn't listed isn't on screen. */
let onScreen: Map<string, { left: number; top: number; width: number; height: number }>;
let root: Root | null = null;
let events: Array<[string, unknown?]>;
const mark = vi.fn(async (_part: string | null) => {});

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const PAGE = sidebarTourPlan({ rail: null, asked: false, markable: false, drawn: true })!;
const CHROME = sidebarTourPlan({ rail: { available: true, hidden: false }, asked: true, markable: true, drawn: false })!;
const read = (step: SidebarTourStep) => readingTimeMs(t(step.copy), "en");
const card = () => document.querySelector<HTMLElement>("[data-sidebar-tour]")?.dataset.sidebarTour ?? null;
const progress = () => document.querySelector("[data-tour-card] .tabular-nums")?.textContent ?? null;

function Tour({ steps, where }: { steps: readonly SidebarTourStep[]; where: RailWhere | null }) {
  const [at, setAt] = useState(0);
  return createElement(SidebarTour, { steps, where, at,
    onStep: (next: number) => { events.push(["step", next]); setAt(next); },
    onShown: (step: string) => events.push(["shown", step]), onLeave: (step: string) => events.push(["leave", step]), onEnd: () => events.push(["end"]) });
}

async function start(plan: { steps: readonly SidebarTourStep[]; where: RailWhere | null }) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Tour, plan)));
  await pass(50);
}

async function pass(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  setLocale("en");
  events = [];
  mark.mockClear();
  onScreen = new Map([["rail-places", box(6, 52, 24, 120)], ["rail-add", box(6, 180, 24, 24)], ["rail-toggle", box(80, 3, 22, 22)],
    ["rail-beside-places", box(0, 40, 36, 140)], ["rail-beside-add", box(0, 40, 36, 140)], ["rail-beside-menu", box(0, 40, 36, 140)]]);
  const rect = (element: Element) => onScreen.get((element as HTMLElement).dataset?.tour ?? "");
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (rect(this) ? [rect(this)] : []) as unknown as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const at = rect(this) ?? box(0, 0, 0, 0);
    return { ...at, x: at.left, y: at.top, right: at.left + at.width, bottom: at.top + at.height, toJSON: () => at } as DOMRect;
  });
  Object.assign(window, { ogb: { rail: { mark } } });
  // The rail drawn on the page, and the button that hides the window's rail, as the app draws them.
  for (const [tag, anchor] of [["ul", "rail-places"], ["button", "rail-add"], ["button", "rail-toggle"]] as const) {
    const target = document.createElement(tag);
    target.dataset.tour = anchor;
    document.body.append(target);
  }
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ogb");
});

describe("the tour of the rail of places", () => {
  it("moves on by itself after each step's reading time, with no buttons, and ends after the last", async () => {
    await start(CHROME);
    const [places, add, menu, strip] = CHROME.steps;
    expect(card()).toBe("places");
    expect(document.querySelector("[data-tour-card]")?.textContent).toContain("Your places: this computer, your Clouds and your own servers.");
    expect(document.querySelectorAll("[data-tour-card] button"), "nothing to press").toHaveLength(0);
    expect(progress()).toBe("Step 1 of 4");
    await pass(read(places!) - 100);
    expect(card(), "still reading").toBe("places");
    await pass(100);
    expect(card()).toBe("add");
    expect(progress()).toBe("Step 2 of 4");
    await pass(read(add!));
    expect(card()).toBe("menu");
    await pass(read(menu!));
    expect(card()).toBe("strip");
    await pass(read(strip!));
    expect(card()).toBeNull();
    expect(events).toEqual([["shown", "places"], ["step", 1], ["shown", "add"], ["step", 2], ["shown", "menu"], ["step", 3], ["shown", "strip"], ["step", 4], ["end"]]);
  });

  it("Escape leaves at the step on screen", async () => {
    await start(CHROME);
    await pass(read(CHROME.steps[0]!));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(events.at(-1)).toEqual(["leave", "add"]);
    expect(events.filter(([name]) => name === "end"), "leaving is not running to the end").toEqual([]);
  });

  it("passes over a step whose target isn't on screen, after a moment for it to appear", async () => {
    onScreen.delete("rail-add");
    await start(PAGE);
    await pass(read(PAGE.steps[0]!));
    expect(card(), "the + isn't there: the card before it stays while the tour waits for it").toBe("places");
    await pass(399);
    expect(events.filter(([name]) => name === "step")).toEqual([["step", 1]]);
    await pass(1);
    expect(card()).toBe("menu");
    expect(events.map(([name, step]) => `${name}:${step ?? ""}`)).not.toContain("shown:add");
  });

  it("a target that appears within that moment is shown", async () => {
    onScreen.delete("rail-places");
    await start(PAGE);
    expect(card()).toBeNull();
    onScreen.set("rail-places", box(6, 52, 24, 120));
    await pass(400);
    await pass(50);
    expect(events[0]).toEqual(["shown", "places"]);
    expect(card()).toBe("places");
  });

  it("with nothing on screen to point at, it ends without showing a step", async () => {
    onScreen.clear();
    await start(PAGE);
    for (let step = 0; step < 3; step++) await pass(400);
    expect(events).toEqual([["step", 1], ["step", 2], ["step", 3], ["end"]]);
  });

  it("beside the window's own rail: the rail marks the part each step points at, shades itself for the page's step, and is cleared after", async () => {
    await start(CHROME);
    expect(document.querySelector('[data-tour="rail-beside-places"]'), "the card stands beside the room the rail takes").not.toBeNull();
    expect(document.querySelector(".ring-accent"), "the page rings nothing: the rail rings its own part").toBeNull();
    for (const step of CHROME.steps) await pass(read(step));
    await act(async () => root?.unmount());
    root = null;
    expect(mark.mock.calls.map(([part]) => part)).toEqual(["places", "add", "places", "dim", null]);
  });

  it("a rail drawn on the page is ringed by the page itself, and the window's rail is never asked", async () => {
    await start(PAGE);
    expect(document.querySelector(".ring-accent")).not.toBeNull();
    expect(document.querySelector('[data-tour^="rail-beside"]')).toBeNull();
    for (const step of PAGE.steps) await pass(read(step));
    expect(events.at(-1)).toEqual(["end"]);
    expect(mark).not.toHaveBeenCalled();
  });

  it("a lone step shows no count", async () => {
    await start(sidebarTourPlan({ rail: { available: true, hidden: true }, asked: true, markable: true, drawn: false })!);
    expect(card()).toBe("strip");
    expect(document.querySelector("[data-tour-card]")?.textContent).toContain("Your places are hidden.");
    expect(progress()).toBeNull();
  });
});
