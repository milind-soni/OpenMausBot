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
import { useSnoozeExpiry, visibleSidebarThreads } from "./SidebarThreadRow";

type Row = { threadId: string; title: string; snoozedUntil?: number };
type Scheduled = { at: number; fire: () => void };
let scheduled: Scheduled | undefined;

function renderProbe(tasks: Row[], active: string) {
  fixture.index = 0; fixture.effects = [];
  function Probe() {
    useSnoozeExpiry(tasks);
    return createElement("ul", null, visibleSidebarThreads(tasks, active).map((task) => createElement("li", { key: task.threadId }, task.threadId)));
  }
  return renderToStaticMarkup(createElement(Probe));
}

describe("snooze expiry wake-up", () => {
  beforeEach(() => {
    fixture.values = []; fixture.index = 0; fixture.effects = []; scheduled = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, delay: number) => { scheduled = { at: Date.now() + delay, fire: callback }; return 1; },
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("hides a future-snoozed thread until the scheduled wake-up makes it reappear without a server snapshot", () => {
    const now = Date.now();
    const tasks: Row[] = [
      { threadId: "active", title: "Active" },
      { threadId: "napping", title: "Napping", snoozedUntil: now + 60_000 },
    ];
    expect(renderProbe(tasks, "active")).toContain("active");
    expect(renderProbe(tasks, "active")).not.toContain("napping");

    expect(fixture.effects).toHaveLength(1);
    fixture.effects[0]!();
    expect(scheduled?.at).toBe(now + 60_001);

    vi.setSystemTime(now + 60_001);
    expect(fixture.values[0]).toBe(0);
    scheduled?.fire();
    expect(fixture.values[0]).toBe(1);
    const html = renderProbe(tasks, "active");
    expect(html).toContain("active");
    expect(html).toContain("napping");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("bounds distant deadlines and re-arms after the first timer chunk", () => {
    const now = Date.now();
    const limit = 2_147_483_647;
    const tasks = [{ threadId: "later", title: "Later", snoozedUntil: now + limit + 60_000 }];
    expect(renderProbe(tasks, "other")).not.toContain("later");
    fixture.effects[0]!();
    expect(scheduled?.at).toBe(now + limit);
    vi.setSystemTime(now + limit);
    scheduled?.fire();
    expect(renderProbe(tasks, "other")).not.toContain("later");
    fixture.effects[0]!();
    expect(scheduled?.at).toBe(now + limit + 60_001);
    vi.setSystemTime(now + limit + 60_001);
    scheduled?.fire();
    expect(renderProbe(tasks, "other")).toContain("later");
  });

  it("still re-renders when the deadline passes between render and effect", () => {
    const now = Date.now();
    const tasks = [{ threadId: "later", title: "Later", snoozedUntil: now + 10 }];
    expect(renderProbe(tasks, "other")).not.toContain("later");
    vi.setSystemTime(now + 20);
    fixture.effects[0]!();
    expect(scheduled?.at).toBe(now + 21);
    scheduled?.fire();
    expect(renderProbe(tasks, "other")).toContain("later");
  });

});
