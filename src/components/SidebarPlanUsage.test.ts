import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import {
  planTitle, POLL_MS, sidebarPlanLabel, sidebarPlanViews, SidebarPlanUsageView, startPlanPoller, WAKE_GAP_MS, windowPercent,
  type PlanPollerHost, type SidebarPlanReport,
} from "./SidebarPlanUsage";

const use = (usedPercent: number | null, available = true) => ({ available, usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent });
const claude = (id: string, fiveHour: number | null, weekly: number | null, extra: Partial<SidebarPlanReport["providers"][number]> = {}) =>
  ({ id, name: id, driver: "claude", ok: true, fiveHour: use(fiveHour), weekly: use(weekly), ...extra });

const copilot = (id: string, monthly: number | null, extra: Partial<SidebarPlanReport["providers"][number]> = {}) => ({
  id, name: id, driver: "copilot", ok: true, fiveHour: use(null, false), weekly: use(null, false),
  extra: monthly === null ? [] : [{ label: "Monthly", kind: "monthly" as const, usedPercent: monthly, remainingPercent: 100 - monthly }], ...extra,
});
const sidebarPlanView = (report: SidebarPlanReport | null) => sidebarPlanViews(report)[0] ?? null;

describe("sidebarPlanViews", () => {
  beforeEach(() => setLocale("en"));

  it("shows the 5-hour and weekly use of the signed-in Claude plan", () => {
    expect(sidebarPlanView({ providers: [claude("Claude", 42.4, 17.6)] })).toEqual({
      state: "ok", product: "claude", name: "Claude", windows: [{ label: "5-hour", percent: 42 }, { label: "Weekly", percent: 17 }],
    });
  });

  it("is hidden without a Claude or Copilot plan that reports a window", () => {
    expect(sidebarPlanViews(null)).toEqual([]);
    expect(sidebarPlanViews({ providers: [] })).toEqual([]);
    expect(sidebarPlanViews({ providers: [claude("Codex", 10, 10, { driver: "codex" })] })).toEqual([]);
    expect(sidebarPlanViews({ providers: [claude("Claude (API key)", null, null), copilot("GitHub Copilot", null)] })).toEqual([]);
  });

  it("says the use is unavailable when Claude's usage check fails", () => {
    expect(sidebarPlanView({ providers: [claude("Claude", null, null, { ok: false })] })).toEqual({ state: "unavailable", product: "claude", name: "Claude" });
  });

  it("prefers a working account over a failing one", () => {
    expect(sidebarPlanView({ providers: [claude("Claude", null, null, { ok: false }), claude("Claude (API key)", 30, 5)] }))
      .toMatchObject({ state: "ok", name: "Claude (API key)" });
  });

  it("drops a window the plan does not report", () => {
    expect(sidebarPlanView({ providers: [claude("Claude", 30, null)] })).toMatchObject({ windows: [{ label: "5-hour", percent: 30 }] });
  });

  it("shows the account whose busiest window is fullest, with both its windows", () => {
    expect(sidebarPlanView({ providers: [claude("Work", 95, 10), claude("Personal", 10, 90)] }))
      .toMatchObject({ name: "Claude · Work", windows: [{ percent: 95 }, { percent: 10 }] });
  });

  it("picks the fuller account by its exact use, not the rounded percent", () => {
    expect(sidebarPlanView({ providers: [claude("Work", 80.1, 10), claude("Personal", 80.9, 10)] })).toMatchObject({ name: "Claude · Personal" });
  });

  it("keeps the first account when a subscription and an API key report the same use", () => {
    expect(sidebarPlanView({ providers: [claude("Claude", 27, 8), claude("Claude (API key)", 27, 8)] })).toMatchObject({ name: "Claude" });
  });

  it("adds a Copilot line with its monthly premium requests, after Claude whatever the report order", () => {
    expect(sidebarPlanViews({ providers: [copilot("GitHub Copilot", 8.4), claude("Claude", 27, 8)] })).toEqual([
      { state: "ok", product: "claude", name: "Claude", windows: [{ label: "5-hour", percent: 27 }, { label: "Weekly", percent: 8 }] },
      { state: "ok", product: "copilot", name: "GitHub Copilot", windows: [{ label: "Monthly", percent: 8 }] },
    ]);
  });

  it("shows Copilot alone, and says when its check fails without hiding Claude", () => {
    expect(sidebarPlanViews({ providers: [copilot("GitHub Copilot", 100)] })).toEqual([
      { state: "ok", product: "copilot", name: "GitHub Copilot", windows: [{ label: "Monthly", percent: 100 }] },
    ]);
    expect(sidebarPlanViews({ providers: [claude("Claude", 27, 8), copilot("Work", null, { ok: false, reason: "failed" })] })).toEqual([
      expect.objectContaining({ state: "ok", name: "Claude" }),
      { state: "unavailable", product: "copilot", name: "Copilot · Work" },
    ]);
  });

  it("leaves Copilot out when nobody signed in to it or the account has no Copilot plan", () => {
    expect(sidebarPlanViews({ providers: [claude("Claude", 27, 8), copilot("GitHub Copilot", null, { ok: false, reason: "signedOut" })] }))
      .toEqual([expect.objectContaining({ name: "Claude" })]);
    expect(sidebarPlanViews({ providers: [copilot("GitHub Copilot", null, { ok: false, reason: "noPlan" })] })).toEqual([]);
  });

  it("still says Claude is unavailable when its sign-in is missing", () => {
    expect(sidebarPlanViews({ providers: [claude("Claude", null, null, { ok: false, reason: "signedOut" })] }))
      .toEqual([{ state: "unavailable", product: "claude", name: "Claude" }]);
  });

  it("finds the monthly window by its kind, not its label", () => {
    expect(sidebarPlanView({ providers: [copilot("GitHub Copilot", null, { extra: [{ label: "Monthly", usedPercent: 40, remainingPercent: 60 }] })] })).toBeNull();
  });

  it("keeps two products apart even when their titles match", () => {
    const views = sidebarPlanViews({ providers: [claude("Copilot · Work", 10, 10), copilot("Work", 20)] });
    expect(views.map((view) => [view.product, view.name])).toEqual([["claude", "Claude · Copilot · Work"], ["copilot", "Copilot · Work"]]);
  });

  it("does not show a Claude extra window as monthly use", () => {
    expect(sidebarPlanView({ providers: [claude("Claude", 27, 8, { extra: [{ label: "Oauth Apps", usedPercent: 50, remainingPercent: 50 }] })] }))
      .toMatchObject({ windows: [{ label: "5-hour" }, { label: "Weekly" }] });
  });
});

describe("windowPercent", () => {
  it("reads 100% only once the window is used up", () => {
    expect(windowPercent(use(99.6))).toBe(99);
    expect(windowPercent(use(100))).toBe(100);
    expect(windowPercent({ available: true, usedPercent: 99.9, remainingPercent: 0 })).toBe(100);
    expect(windowPercent(use(0))).toBe(0);
    expect(windowPercent(use(50, false))).toBeNull();
  });
});

describe("planTitle", () => {
  it("keeps the product in the title of a renamed account", () => {
    expect(planTitle("Claude", "Claude")).toBe("Claude");
    expect(planTitle("Claude", "Claude (API key)")).toBe("Claude (API key)");
    expect(planTitle("Claude", "Work")).toBe("Claude · Work");
    expect(planTitle("Copilot", "GitHub Copilot")).toBe("GitHub Copilot");
    expect(planTitle("Claude", "Work (not claude)")).toBe("Claude · Work (not claude)");
    expect(planTitle("Copilot", "Work")).toBe("Copilot · Work");
  });
});

describe("SidebarPlanUsageView", () => {
  beforeEach(() => setLocale("en"));

  it("colours a window by how close it is to the limit", () => {
    const html = renderToStaticMarkup(createElement(SidebarPlanUsageView, {
      view: { state: "ok", product: "claude", name: "Claude", windows: [{ label: "5-hour", percent: 85 }, { label: "Weekly", percent: 100 }] }, onOpen: () => {},
    }));
    expect(html).toContain('data-band="near"');
    expect(html).toContain('data-band="full"');
    expect(html).toContain("85%");
  });

  it("names the account, its windows and where the button leads", () => {
    expect(sidebarPlanLabel({ state: "ok", product: "claude", name: "Claude", windows: [{ label: "5-hour", percent: 27 }, { label: "Weekly", percent: 7 }] }))
      .toBe("Claude: 5-hour 27%, Weekly 7% Plan usage");
    expect(sidebarPlanLabel({ state: "unavailable", product: "claude", name: "Claude" })).toBe("Claude: Could not load plan usage. Plan usage");
  });
});

describe("startPlanPoller", () => {
  const host = () => {
    const state = { at: 0, visible: true, ticks: [] as Array<{ run: () => void; ms: number }>, wakes: [] as Array<() => void> };
    const api: PlanPollerHost = {
      now: () => state.at,
      visible: () => state.visible,
      every: (run, ms) => { const tick = { run, ms }; state.ticks.push(tick); return () => { state.ticks = state.ticks.filter((t) => t !== tick); }; },
      onWake: (run) => { state.wakes.push(run); return () => { state.wakes = state.wakes.filter((w) => w !== run); }; },
    };
    return { state, api };
  };
  const counter = () => { const loads = { count: 0, load: () => { loads.count++; } }; return loads; };

  it("loads at once, then on every tick", () => {
    const { state, api } = host(), loads = counter();
    startPlanPoller(loads.load, api, { every: POLL_MS, last: { at: Number.NEGATIVE_INFINITY } });
    expect(loads.count).toBe(1);
    expect(state.ticks[0]!.ms).toBe(POLL_MS);
    state.at += POLL_MS; state.ticks[0]!.run();
    expect(loads.count).toBe(2);
  });

  it("loads on waking at most once a minute", () => {
    const { state, api } = host(), loads = counter();
    startPlanPoller(loads.load, api, { every: POLL_MS, last: { at: Number.NEGATIVE_INFINITY } });
    state.at += 10_000; state.wakes[0]!();
    expect(loads.count).toBe(1);
    state.at += WAKE_GAP_MS; state.wakes[0]!();
    expect(loads.count).toBe(2);
  });

  it("does not load while the app is hidden", () => {
    const { state, api } = host(), loads = counter();
    state.visible = false;
    startPlanPoller(loads.load, api, { every: POLL_MS, last: { at: Number.NEGATIVE_INFINITY } });
    state.at += POLL_MS; state.ticks[0]!.run();
    expect(loads.count).toBe(0);
  });

  it("only listens for waking without a timer, and does not repeat a recent load on restart", () => {
    const { state, api } = host(), loads = counter(), last = { at: Number.NEGATIVE_INFINITY };
    startPlanPoller(loads.load, api, { every: POLL_MS, last })();
    startPlanPoller(loads.load, api, { every: null, last });
    expect(loads.count).toBe(1);
    expect(state.ticks).toHaveLength(0);
    expect(state.wakes).toHaveLength(1);
  });

  it("stops listening once stopped", () => {
    const { state, api } = host(), loads = counter();
    const stop = startPlanPoller(loads.load, api, { every: POLL_MS, last: { at: Number.NEGATIVE_INFINITY } });
    stop();
    expect(state.ticks).toHaveLength(0);
    expect(state.wakes).toHaveLength(0);
  });
});
