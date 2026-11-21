// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMinuteTick } from "./minute-tick";

const { CalendarGrid } = await import("@/components/routines/CalendarGrid");

let root: Root | null = null;
const mount = (element: ReturnType<typeof createElement>) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
  return container;
};
const advance = (ms: number) => flushSync(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 20, 23, 58, 30) }); });
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("the minute tick", () => {
  it("draws its readers once as each minute turns, on one timer, and keeps no timer once none reads it", () => {
    const drawn: number[] = [];
    function Clock() { drawn.push(useMinuteTick()); return null; }
    function Two() { return [createElement(Clock, { key: "a" }), createElement(Clock, { key: "b" })]; }
    mount(createElement(Two));
    expect(drawn).toEqual([new Date(2026, 10, 20, 23, 58).getTime(), new Date(2026, 10, 20, 23, 58).getTime()]);
    expect(vi.getTimerCount()).toBe(1);
    advance(29_000);
    expect(drawn).toHaveLength(2);
    advance(1_001);
    expect(drawn.slice(2)).toEqual([new Date(2026, 10, 20, 23, 59).getTime(), new Date(2026, 10, 20, 23, 59).getTime()]);
    advance(59_000);
    expect(drawn).toHaveLength(4);
    advance(1_000);
    expect(drawn).toHaveLength(6);
    flushSync(() => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves the calendar's today and its now line across midnight with nothing else changing", () => {
    const day = new Date(2026, 10, 20).getTime(), next = new Date(2026, 10, 21).getTime();
    const container = mount(createElement(CalendarGrid, {
      anchor: day, days: 2, items: [], bots: [], groups: [], onOpen: vi.fn(), onCreate: vi.fn(), onMove: vi.fn(), onResize: vi.fn(),
    }));
    const today = () => [...container.querySelectorAll('[role="columnheader"]')].findIndex((header) => header.className.includes("bg-accent"));
    const nowLine = () => [...container.querySelectorAll('[role="gridcell"]')].findIndex((cell) => cell.querySelector(".bg-danger") !== null);
    expect([today(), nowLine()]).toEqual([0, 0]);
    advance(91_000);
    expect(Date.now()).toBeGreaterThanOrEqual(next);
    expect([today(), nowLine()]).toEqual([1, 1]);
  });
});
