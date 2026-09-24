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
import { BotThreadList } from "./Sidebar";
import type { Bot } from "@/state/store";
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { pendingQueued: {} }, dispatch: vi.fn() }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

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

  it("schedules the wake-up from the production thread list so a snoozed row reappears at its deadline", () => {
    const now = Date.now();
    const bot: Bot = {
      id: "maus", threadId: "current", name: "Maus", title: "", description: "", notifications: true,
      color: "green", unread: false, busy: true, messages: [], modelSelection: { instanceId: "fake", model: "fake" },
      tasks: [
        { threadId: "current", title: "Current chat", createdAt: 1, busy: true, activity: "working" },
        { threadId: "napping", title: "Napping", createdAt: 2, snoozedUntil: now + 60_000 },
      ],
    };
    const render = () => {
      fixture.index = 0; fixture.effects = [];
      return renderToStaticMarkup(createElement(BotThreadList, { bot, selected: true }));
    };
    const hidden = render();
    expect(hidden).toContain("Current chat");
    expect(hidden).not.toContain("Napping");

    // The production list itself must schedule the wake-up: without the
    // useSnoozeExpiry call in BotThreadList no effect sets a timer.
    for (const effect of fixture.effects) effect();
    expect(scheduled?.at).toBe(now + 60_001);

    vi.setSystemTime(now + 60_001);
    const beforeFire = [...fixture.values];
    scheduled?.fire();
    const changed = beforeFire
      .map((previous, index) => [previous, fixture.values[index]] as const)
      .filter(([previous, current]) => previous !== current);
    expect(changed).toHaveLength(1);
    expect(changed[0]![1]).toBe((changed[0]![0] as number) + 1);
    expect(render()).toContain("Napping");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
