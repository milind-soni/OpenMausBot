import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUBMENU_DWELL_MS, SUBMENU_GRACE_MS, submenuIntent, towardSubmenu } from "./submenu-intent";

const submenu = { left: 300, right: 500, top: 100, bottom: 300 };

function setup() {
  const events: string[] = [];
  const intent = submenuIntent({ open: (key) => events.push(`open ${key}`), close: () => events.push("close"), submenuBox: () => submenu });
  const dwellOpen = (key = "support", point = { x: 200, y: 150 }) => {
    intent.enterRow(key, true, point);
    vi.advanceTimersByTime(SUBMENU_DWELL_MS);
  };
  return { intent, events, dwellOpen };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("submenu hover intent", () => {
  it("does not open a submenu the pointer only passes through", () => {
    const { intent, events } = setup();
    intent.enterRow("support", true, { x: 200, y: 150 });
    vi.advanceTimersByTime(90);
    intent.leaveRow("support");
    intent.enterRow("settings", false, { x: 200, y: 184 });
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });

  it("opens once the pointer rests on the row for the dwell time", () => {
    const { intent, events } = setup();
    intent.enterRow("support", true, { x: 200, y: 150 });
    vi.advanceTimersByTime(SUBMENU_DWELL_MS - 1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["open support"]);
    expect(intent.openKey).toBe("support");
  });

  it("closes at once when the pointer enters a sibling row that is not on the way to the submenu", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.enterRow("settings", false, { x: 200, y: 184 });
    expect(events).toEqual(["open support", "close"]);
    expect(intent.openKey).toBeNull();
  });

  it("swaps to a sibling submenu only after its own dwell", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.enterRow("phone", true, { x: 200, y: 220 });
    expect(events).toEqual(["open support", "close"]);
    vi.advanceTimersByTime(SUBMENU_DWELL_MS);
    expect(events).toEqual(["open support", "close", "open phone"]);
  });

  it("keeps the submenu open while the pointer heads into it, for the grace period at most", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.move({ x: 220, y: 150 }, true);
    intent.enterRow("settings", false, { x: 260, y: 170 });
    vi.advanceTimersByTime(SUBMENU_GRACE_MS - 1);
    expect(events).toEqual(["open support"]);
    intent.enterSubmenu();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(["open support"]);

    const late = setup();
    late.dwellOpen();
    late.intent.move({ x: 220, y: 150 }, true);
    late.intent.enterRow("settings", false, { x: 260, y: 170 });
    vi.advanceTimersByTime(SUBMENU_GRACE_MS);
    expect(late.events).toEqual(["open support", "close"]);
  });

  it("closes during the grace period as soon as the pointer turns away from the submenu", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.move({ x: 220, y: 150 }, true);
    intent.enterRow("settings", false, { x: 260, y: 170 });
    intent.move({ x: 230, y: 240 }, false);
    expect(events).toEqual(["open support", "close"]);
  });

  it("opens and closes at once from a click or the keyboard", () => {
    const { intent, events } = setup();
    intent.openNow("support");
    expect(events).toEqual(["open support"]);
    intent.closeNow();
    expect(events).toEqual(["open support", "close"]);
    intent.closeNow();
    expect(events).toEqual(["open support", "close"]);
  });

  it("forgets a pending dwell when the pointer leaves the menu", () => {
    const { intent, events } = setup();
    intent.enterRow("support", true, { x: 200, y: 150 });
    intent.leaveMenu();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });
});

describe("towardSubmenu", () => {
  it("is true inside the triangle from the pointer to the submenu's near edge, on either side", () => {
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 260, y: 170 }, submenu)).toBe(true);
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 200, y: 200 }, submenu)).toBe(false);
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 150, y: 150 }, submenu)).toBe(false);
    const left = { left: 0, right: 100, top: 100, bottom: 300 };
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 150, y: 160 }, left)).toBe(true);
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 250, y: 160 }, left)).toBe(false);
  });
});
