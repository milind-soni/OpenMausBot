// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FLIGHT_MS, LANDING_MS, landInSidebar } from "./mausbot-landing";

type Played = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; finish(): void };
let played: Played[] = [];
const rects = new Map<Element, { left: number; top: number; width: number; height: number }>();
const place = (el: Element, left: number, top: number, width: number, height: number) => rects.set(el, { left, top, width, height });

beforeEach(() => {
  played = [];
  rects.clear();
  document.body.innerHTML = "";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const { left, top, width, height } = rects.get(this) ?? { left: 0, top: 0, width: 0, height: 0 };
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} } as DOMRect;
  });
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { onfinish: null as null | (() => void), oncancel: null as null | (() => void) };
    played.push({ el: this, keyframes, options, finish: () => animation.onfinish?.() });
    return animation as unknown as Animation;
  } as typeof Element.prototype.animate;
});
afterEach(() => vi.restoreAllMocks());

function row(id: string, top: number): HTMLElement {
  const element = document.createElement("div");
  element.dataset.sidebarBotRow = id;
  const avatar = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  element.appendChild(avatar);
  place(element, 8, top, 280, 40);
  place(avatar, 16, top + 6, 28, 28);
  return element;
}

function sidebar() {
  const list = document.createElement("nav");
  const ada = row("ada", 100), bea = row("bea", 140);
  list.append(ada, bea);
  const from = document.createElement("span");
  place(from, 584, 160, 112, 112);
  document.body.append(list, from);
  const maus = row("maus", 100);
  const commit = vi.fn(() => {
    list.prepend(maus);
    place(ada, 8, 140, 280, 40);
    place(ada.firstElementChild!, 16, 146, 28, 28);
    place(bea, 8, 180, 280, 40);
  });
  return { ada, bea, maus, from, commit };
}

describe("MausBot landing in the sidebar", () => {
  it("glides the rows already there down by its height, flies the avatar into the new top slot and shows the row as it lands", () => {
    const s = sidebar();
    landInSidebar({ from: s.from, botId: "maus", reduced: false, commit: s.commit });
    expect(s.commit).toHaveBeenCalledOnce();
    for (const shifted of [s.ada, s.bea]) {
      const glide = played.find((entry) => entry.el === shifted)!;
      expect(glide.keyframes).toEqual([{ transform: "translateY(-40px)" }, { transform: "translateY(0)" }]);
      expect(glide.options).toMatchObject({ duration: LANDING_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
    expect(played.find((entry) => entry.el === s.maus)!.keyframes).toEqual([{ opacity: 0 }, { opacity: 0, offset: 0.72 }, { opacity: 1 }]);
    const ghost = played.find((entry) => entry.el !== s.ada && entry.el !== s.bea && entry.el !== s.maus)!;
    const flown = ghost.el as HTMLElement;
    expect(flown.style.pointerEvents).toBe("none");
    expect(flown.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.keyframes.at(-1)).toEqual({ transform: `translate(${16 - 584}px, ${106 - 160}px) scale(${28 / 112})` });
    expect(ghost.options.duration).toBe(FLIGHT_MS);
    expect(FLIGHT_MS + 100).toBeLessThanOrEqual(800);
    expect(s.from.style.visibility).toBe("hidden");
    expect(document.body.contains(flown)).toBe(true);
    ghost.finish();
    played.find((entry) => entry.el === flown && entry !== ghost)!.finish();
    expect(document.body.contains(flown)).toBe(false);
    expect(played.every((entry) => !("opacity" in (entry.keyframes.at(-1) ?? {})) || entry.keyframes.at(-1)!.opacity === 1 || entry.el === flown)).toBe(true);
  });

  it("only fades the row in when motion is reduced", () => {
    const s = sidebar();
    landInSidebar({ from: s.from, botId: "maus", reduced: true, commit: s.commit });
    expect(played.map((entry) => [entry.el, entry.keyframes])).toEqual([[s.maus, [{ opacity: 0 }, { opacity: 1 }]]]);
    expect(s.from.style.visibility).toBe("");
  });

  it("just adds it when the sidebar is hidden", () => {
    const s = sidebar();
    const commit = vi.fn();
    landInSidebar({ from: s.from, botId: "maus", reduced: false, commit });
    expect(commit).toHaveBeenCalledOnce();
    expect(played).toEqual([]);
  });
});
