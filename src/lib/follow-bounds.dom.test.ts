// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { followBounds } from "./follow-bounds";

let box = { left: 300, top: 120, width: 900, height: 700 };
let element: HTMLDivElement;
let stop: () => void;
const frames = async (count: number) => { for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); };

beforeEach(() => {
  box = { left: 300, top: 120, width: 900, height: 700 };
  element = document.createElement("div");
  document.body.append(element);
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) }) as DOMRect);
});
afterEach(() => {
  stop?.();
  element.remove();
  vi.restoreAllMocks();
});

describe("following a box a native view sits over", () => {
  it("follows every frame of a sidebar sliding, which moves the box without resizing it", async () => {
    const seen: number[] = [];
    stop = followBounds(element, () => seen.push(element.getBoundingClientRect().left));
    document.body.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    for (const left of [280, 240, 180, 120, 80]) {
      box = { ...box, left };
      await frames(1);
    }
    document.body.dispatchEvent(new Event("transitionend", { bubbles: true }));
    await frames(6);
    expect(seen).toEqual([280, 240, 180, 120, 80]);
  });

  it("goes quiet once the box keeps still, and wakes on a page change", async () => {
    const moved = vi.fn();
    stop = followBounds(element, moved);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    await frames(8);
    raf.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(raf.mock.calls.length).toBe(0);
    expect(moved).not.toHaveBeenCalled();
    box = { ...box, top: 40 };
    document.body.className = "maximized";
    await frames(4);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("stops following when stopped", async () => {
    const moved = vi.fn();
    stop = followBounds(element, moved);
    stop();
    document.body.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    box = { ...box, left: 10 };
    await frames(3);
    expect(moved).not.toHaveBeenCalled();
  });
});
