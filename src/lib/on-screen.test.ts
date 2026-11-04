// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNearScreen } from "./on-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The module makes its observer once, on first use, so only the first test that watches sees this fake's reports.
class FakeObserver {
  static last: FakeObserver | undefined;
  watched = new Set<Element>();
  constructor(
    public report: (changes: { target: Element; isIntersecting: boolean }[]) => void,
    public options?: IntersectionObserverInit,
  ) {
    FakeObserver.last = this;
  }
  observe(target: Element) { this.watched.add(target); }
  unobserve(target: Element) { this.watched.delete(target); }
}

function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  return createElement("div", { ref, "data-near": String(useNearScreen(ref)) });
}

let host: HTMLDivElement;
let root: Root;
const near = () => (host.firstElementChild as HTMLElement).dataset.near;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("useNearScreen", () => {
  it("is false until the element comes near, then stays true and stops watching", () => {
    act(() => root.render(createElement(Probe)));
    const watcher = FakeObserver.last!;
    const element = host.firstElementChild!;
    expect([...watcher.watched]).toEqual([element]);
    expect(watcher.options).toMatchObject({ rootMargin: "800px 0px" });
    act(() => watcher.report([{ target: element, isIntersecting: false }]));
    expect(near()).toBe("false");
    act(() => watcher.report([{ target: element, isIntersecting: true }]));
    expect(near()).toBe("true");
    expect(watcher.watched.size).toBe(0);
  });

  it("is true at once where the browser cannot tell", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    act(() => root.render(createElement(Probe)));
    expect(near()).toBe("true");
  });
});
