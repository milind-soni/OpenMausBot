// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/components/Avatar", () => ({
  MausAvatar: ({ color, animated, trackPointer }: { color: string; animated: boolean; trackPointer?: boolean }) =>
    createElement("i", { "data-maus": color, "data-animated": String(animated), "data-pointer": String(trackPointer) }),
}));
const { TeamPicture } = await import("./TeamPicture");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const render = async (active = true) => { await act(async () => { root.render(createElement(TeamPicture, { active })); }); };
const mascots = () => [...host.querySelectorAll<HTMLElement>("[data-maus]")];
const texts = () => [...host.querySelectorAll("text")].map(node => node.textContent);

beforeEach(() => { setLocale("en"); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete document.documentElement.dataset.reducedMotion; });

it("is one labelled picture: four teammates, each with a Chief of Staff of their own, around the team's shared bots in two departments", async () => {
  await render();
  const picture = host.querySelector('svg[role="img"]')!;
  expect(picture.getAttribute("aria-label")).toBe("Ada, Ben, Cleo and Dara, each with their own Chief of Staff, share the team's Support and Sales bots on one Team Cloud.");
  expect(texts()).toEqual(["Support", "Sales", "A", "Ada", "B", "Ben", "C", "Cleo", "D", "Dara"]);
  expect(mascots().map(node => node.dataset.maus), "the departments' bots, then each person's Chief").toEqual(["cyan", "blue", "pink", "orange", "pink", "green", "yellow", "cyan"]);
  expect(host.querySelectorAll('path[d^="M0 5.5"]'), "a crown on each Chief").toHaveLength(4);
  expect(mascots().every(node => node.dataset.pointer === "false"), "no bot follows the pointer").toBe(true);
});

it("work moves to the shared bots only while it may: never under reduced motion, nor on a slide that isn't on screen", async () => {
  await render();
  expect(host.querySelectorAll("animateMotion")).toHaveLength(8);
  expect(mascots().every(node => node.dataset.animated === "true")).toBe(true);
  await render(false);
  expect(host.querySelectorAll("animateMotion")).toHaveLength(0);
  expect(mascots().every(node => node.dataset.animated === "false")).toBe(true);
  await render(true);
  document.documentElement.dataset.reducedMotion = "true";
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelectorAll("animateMotion")).toHaveLength(0);
  expect(mascots().every(node => node.dataset.animated === "false")).toBe(true);
});
