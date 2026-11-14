import type { WheelEvent } from "react";
import { describe, expect, it } from "vitest";

import { scrollTabsWithWheel } from "./computer-panel-tabs";

function wheel(row: { scrollWidth: number; clientWidth: number; scrollLeft: number }, deltaX: number, deltaY: number) {
  scrollTabsWithWheel({ currentTarget: row, deltaX, deltaY } as unknown as WheelEvent<HTMLElement>);
  return row.scrollLeft;
}

describe("the computer panel's tab row under a mouse wheel", () => {
  it("scrolls sideways when its tabs do not fit", () => {
    expect(wheel({ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 }, 0, 40)).toBe(40);
    expect(wheel({ scrollWidth: 600, clientWidth: 300, scrollLeft: 100 }, 0, -40)).toBe(60);
  });

  it("leaves a row that fits, and a sideways gesture the browser already handles, alone", () => {
    expect(wheel({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 }, 0, 40)).toBe(0);
    expect(wheel({ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 }, 50, 10)).toBe(0);
  });
});
