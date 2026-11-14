// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAUS_COLOR_NAMES } from "@/lib/mascot";

type Seen = { color: string; state: string; animated: boolean; trackPointer?: boolean; size: number };
vi.mock("@/components/Avatar", () => ({
  MausAvatar: ({ color, state, animated, trackPointer, size: _size, ...choreography }: Seen) => createElement("i", {
    "data-maus": color, "data-state": state, "data-animated": String(animated), "data-pointer": String(trackPointer),
    "data-extra": Object.keys(choreography).join(",") }),
}));
const { NightCard } = await import("./NightCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const render = async (small = false) => { await act(async () => { root.render(createElement(NightCard, { small, children: createElement("h2", null, "MausBot Cloud") })); }); };
const card = () => host.querySelector<HTMLElement>("[data-night-card]")!;
const mascots = () => [...host.querySelectorAll<HTMLElement>("[data-maus]")];
const animated = () => mascots().map(node => node.dataset.animated);
const motion = () => ["twinkle", "z", "shoot"].map(name => host.querySelectorAll(`.cloud-night-${name}`).length);

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("the scene is hidden from screen readers: the card's own text is what is read", async () => {
  await render();
  expect(card().querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  expect(card().textContent).toBe("MausBot Cloud");
  expect(card().querySelector("h2")!.closest("svg"), "the text sits outside the scene").toBeNull();
});

it("three of the app's own mascots ride the cloud in three colours, each in a calm state, never following the pointer", async () => {
  await render();
  const colors = mascots().map(node => node.dataset.maus!);
  expect(colors).toHaveLength(3);
  expect(new Set(colors).size).toBe(3);
  for (const color of colors) expect(MAUS_COLOR_NAMES).toContain(color);
  expect(mascots().map(node => node.dataset.state)).toEqual(["working", "idle", "thinking"]);
  expect(mascots().map(node => node.dataset.extra), "no faces, gazes or motions laid on top").toEqual(["", "", ""]);
  expect(mascots().map(node => node.dataset.pointer)).toEqual(["false", "false", "false"]);
});

it("live, one star twinkles, the z's drift and now and then a star shoots, all in CSS: no timer or frame of its own", async () => {
  vi.useFakeTimers();
  await render();
  expect(card().hasAttribute("data-paused")).toBe(false);
  expect(animated()).toEqual(["true", "true", "true"]);
  expect(motion(), "twinkling stars, drifting z's, shooting stars").toEqual([1, 3, 1]);
  expect(vi.getTimerCount(), "no setTimeout, setInterval or requestAnimationFrame").toBe(0);
  const markup = host.innerHTML;
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(host.innerHTML, "nothing changes on a clock").toBe(markup);
});

it("its CSS moves three things, slowly, and holds them while paused", () => {
  const css = readFileSync("src/styles.css", "utf8");
  expect([...css.matchAll(/@keyframes (cloud-night-[\w-]+)/g)].map(match => match[1])).toEqual(["cloud-night-twinkle", "cloud-night-z", "cloud-night-shoot"]);
  for (const [, seconds] of css.matchAll(/animation: cloud-night-[\w-]+ ([\d.]+)s/g)) expect(Number(seconds)).toBeGreaterThanOrEqual(7);
  expect(css).toContain(".cloud-night[data-paused] * { animation-play-state: paused; }");
});

it("reduced motion is the same scene held still: no animation at all and the mascots still", async () => {
  document.documentElement.dataset.reducedMotion = "true";
  await render();
  expect(motion()).toEqual([0, 0, 0]);
  expect(animated()).toEqual(["false", "false", "false"]);
  expect(host.querySelectorAll("[style*='animation']")).toHaveLength(0);
  expect(host.querySelectorAll("path[d^='M-2.6-2.6']"), "the z's still rise from the laptop").toHaveLength(3);
});

it("the system setting or the dev hook, switched while the card is shown, stills it at once and lets it go again", async () => {
  let reduce = false;
  const changes = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: reduce && query.includes("reduce"), media: query,
    addEventListener: (_: string, changed: () => void) => changes.add(changed), removeEventListener: (_: string, changed: () => void) => changes.delete(changed) }) as unknown as MediaQueryList);
  const still = () => motion().every(count => count === 0) && animated().every(flag => flag === "false");
  const moving = () => motion().every(count => count > 0) && animated().every(flag => flag === "true");
  await render();
  expect(moving()).toBe(true);
  reduce = true;
  await act(async () => { changes.forEach(changed => changed()); });
  expect(still(), "system setting on").toBe(true);
  reduce = false;
  await act(async () => { changes.forEach(changed => changed()); });
  expect(moving(), "system setting off").toBe(true);
  await act(async () => { document.documentElement.dataset.reducedMotion = "true"; await Promise.resolve(); });
  expect(still(), "dev hook on").toBe(true);
  await act(async () => { delete document.documentElement.dataset.reducedMotion; await Promise.resolve(); });
  expect(moving(), "dev hook off").toBe(true);
});

it("out of view it holds: the mascots stop and the CSS animations pause until it is back", async () => {
  let visible: (seen: boolean) => void = () => {};
  vi.stubGlobal("IntersectionObserver", class {
    constructor(report: IntersectionObserverCallback) {
      visible = seen => report([{ isIntersecting: seen } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect() {}
  });
  await render();
  await act(async () => visible(false));
  expect(card().hasAttribute("data-paused")).toBe(true);
  expect(animated()).toEqual(["false", "false", "false"]);
  await act(async () => visible(true));
  expect(card().hasAttribute("data-paused")).toBe(false);
  expect(animated()).toEqual(["true", "true", "true"]);
});

it("the Cloud Pro popup's card is the smaller one", async () => {
  await render();
  expect(card().className).toContain("h-[120px]");
  await render(true);
  expect(card().className).toContain("h-[92px]");
});
