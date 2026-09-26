import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next; }];
  },
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
import { useRelativeNow } from "./SidebarThreadRow";
import { BotThreadList } from "./Sidebar";
import type { Bot } from "@/state/store";
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { pendingQueued: {} }, dispatch: vi.fn() }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

type Interval = { delay: number; fire: () => void; cleared: boolean };
const intervals: Interval[] = [];
type VisibilityHandler = () => void;
let documentStub: {
  visibilityState: string;
  listeners: Record<string, VisibilityHandler[]>;
  addEventListener: (type: string, handler: VisibilityHandler) => void;
  removeEventListener: (type: string, handler: VisibilityHandler) => void;
};

function renderProbe() {
  fixture.index = 0; fixture.effects = [];
  function Probe() { return createElement("output", null, String(useRelativeNow())); }
  return renderToStaticMarkup(createElement(Probe));
}

/** Effects never run in a static render; calling them by hand registers the
 * timer the way a live list would, and each returns its cleanup. */
const runEffects = () => fixture.effects.map((effect) => effect());

describe("relative clock tick", () => {
  beforeEach(() => {
    fixture.values = []; fixture.index = 0; fixture.effects = []; intervals.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    documentStub = {
      visibilityState: "visible",
      listeners: {},
      addEventListener: (type, handler) => { (documentStub.listeners[type] ??= []).push(handler); },
      removeEventListener: (type, handler) => { documentStub.listeners[type] = (documentStub.listeners[type] ?? []).filter((entry) => entry !== handler); },
    };
    vi.stubGlobal("window", {
      setInterval: (callback: () => void, delay: number) => { const entry = { delay, fire: callback, cleared: false }; intervals.push(entry); return intervals.length; },
      clearInterval: (id: number) => { const entry = intervals[id - 1]; if (entry) entry.cleared = true; },
    });
    vi.stubGlobal("document", documentStub);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("starts at the wall clock, re-ticks every 30 seconds, and clears on unmount", () => {
    const start = Date.now();
    expect(renderProbe()).toBe(`<output>${start}</output>`);
    const cleanups = runEffects();
    expect(intervals.map((entry) => entry.delay)).toEqual([30_000]);
    expect(documentStub.listeners["visibilitychange"]).toHaveLength(1);
    vi.setSystemTime(start + 30_000);
    intervals[0]!.fire();
    expect(fixture.values[0]).toBe(start + 30_000);
    vi.setSystemTime(start + 90_000);
    intervals[0]!.fire();
    expect(fixture.values[0]).toBe(start + 90_000);
    for (const cleanup of cleanups) (cleanup as () => void | undefined)?.();
    expect(intervals[0]!.cleared).toBe(true);
    expect(documentStub.listeners["visibilitychange"]).toHaveLength(0);
  });

  it("pauses the tick while the window is hidden", () => {
    const start = Date.now();
    renderProbe();
    runEffects();
    documentStub.visibilityState = "hidden";
    vi.setSystemTime(start + 30_000);
    intervals[0]!.fire();
    expect(fixture.values[0]).toBe(start);
    documentStub.visibilityState = "visible";
    vi.setSystemTime(start + 60_000);
    intervals[0]!.fire();
    expect(fixture.values[0]).toBe(start + 60_000);
  });

  it("resyncs the moment the window becomes visible again", () => {
    const start = Date.now();
    renderProbe();
    const cleanups = runEffects();
    documentStub.visibilityState = "hidden";
    vi.setSystemTime(start + 2 * 86_400_000);
    documentStub.listeners["visibilitychange"]![0]!();
    // still hidden: the resync waits for visibility like the tick does
    expect(fixture.values[0]).toBe(start);
    documentStub.visibilityState = "visible";
    documentStub.listeners["visibilitychange"]![0]!();
    expect(fixture.values[0]).toBe(start + 2 * 86_400_000);
    for (const cleanup of cleanups) (cleanup as () => void | undefined)?.();
    expect(documentStub.listeners["visibilitychange"]).toHaveLength(0);
  });

  it("runs the shared clock from the production thread list: one timer for every row", () => {
    const now = Date.now();
    const bot: Bot = {
      id: "maus", threadId: "current", name: "Maus", title: "", description: "", notifications: true,
      color: "green", unread: false, busy: false, messages: [], modelSelection: { instanceId: "fake", model: "fake" },
      tasks: [
        { threadId: "current", title: "Current chat", createdAt: now - 10_000, busy: false, activity: "idle" },
        { threadId: "older", title: "Older thread", createdAt: now - 5 * 60_000, busy: false, activity: "idle" },
      ],
    };
    fixture.index = 0; fixture.effects = [];
    const markup = renderToStaticMarkup(createElement(BotThreadList, { bot, selected: true }));
    expect(markup).toContain("just now");
    expect(markup).toContain("5 min ago");
    runEffects();
    expect(intervals.filter((entry) => !entry.cleared)).toHaveLength(1);
    expect(intervals[0]!.delay).toBe(30_000);
  });
});
