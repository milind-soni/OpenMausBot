// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageLoading } from "./ImageLoading";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Change = { target: Element; isIntersecting: boolean };
const observer: { report: ((changes: Change[]) => void) | null; watched: Set<Element> } = { report: null, watched: new Set() };
vi.stubGlobal("IntersectionObserver", class {
  constructor(report: (changes: Change[]) => void) {
    observer.report = report;
  }
  observe(target: Element) { observer.watched.add(target); }
  unobserve(target: Element) { observer.watched.delete(target); }
  disconnect() {}
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

afterAll(() => vi.unstubAllGlobals());

describe("an image's loading tile", () => {
  it("holds still off screen and pulses only while it can be seen", () => {
    act(() => root.render(createElement(ImageLoading, { name: "chart.png", className: "absolute inset-0" })));
    const tile = host.querySelector<HTMLElement>("[role=status]")!;
    const moving = () => [tile.classList.contains("animate-pulse"), tile.querySelector("svg")!.classList.contains("animate-spin")];
    expect(tile.textContent).toBe("Loading chart.png");
    expect(moving()).toEqual([false, false]);
    act(() => observer.report!([{ target: tile, isIntersecting: true }]));
    expect(moving()).toEqual([true, true]);
    act(() => observer.report!([{ target: tile, isIntersecting: false }]));
    expect(moving()).toEqual([false, false]);
  });

  it("stops watching once the image has loaded", () => {
    act(() => root.render(createElement(ImageLoading, { name: "chart.png", className: "absolute inset-0" })));
    expect(observer.watched.size).toBe(1);
    act(() => root.render(null));
    expect(observer.watched.size).toBe(0);
  });
});
