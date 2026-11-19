import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMapSession } from "@/lib/team-map";

const fixture = vi.hoisted(() => ({ report: null as unknown }));
vi.mock("./PlanUsage", async (original) => ({
  ...await original<typeof import("./PlanUsage")>(),
  usePlanUsage: () => ({ report: fixture.report }),
}));
const { ALL_SECTIONS_FILTER, TeamMapStatusStrip } = await import("./TeamMapStatusStrip");

function session(overrides: Partial<TeamMapSession> = {}): TeamMapSession {
  return { botId: "ada", threadId: "ada-1", title: "Fix the flaky test", state: "running", startedAt: 0, ...overrides };
}

function render(sessions: TeamMapSession[], extra: Partial<Parameters<typeof TeamMapStatusStrip>[0]> = {}) {
  return renderToStaticMarkup(createElement(TeamMapStatusStrip, {
    sessions, doneLast24h: 0, sectionOptions: [], sectionFilter: ALL_SECTIONS_FILTER,
    onSectionFilterChange: () => {}, live: true, onToggleLive: () => {}, ...extra,
  }));
}

beforeEach(() => {
  fixture.report = null;
});

describe("team map status strip", () => {
  it("counts sessions by state and shows how many finished recently", () => {
    const html = render([session({ state: "running" }), session({ threadId: "b", state: "stuck" }), session({ threadId: "c", state: "running" })], { doneLast24h: 5 });
    expect(html).toContain("2 working");
    expect(html).toContain("1 stuck");
    expect(html).not.toContain("waiting");
    expect(html).toContain("5 done");
  });

  it("omits counts and the done tally when there is nothing to report", () => {
    const html = render([]);
    expect(html).not.toContain("working");
    expect(html).not.toContain("done");
  });

  it("shows a compact per-provider usage bar from the plan usage hook, never refetching on its own", () => {
    fixture.report = { fetchedAt: "now", providers: [{
      id: "claude", name: "Claude (API key)", driver: "claude", plan: "Pro", ok: true, error: null,
      fiveHour: { available: true, remainingPercent: 70, usedPercent: 30, resetsAt: null },
      weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [],
    }] };
    const html = render([]);
    expect(html).toContain("30%");
    expect(html).toContain(">5-hour<");
    expect(html).toContain('role="meter"');
  });

  it("names the window it shows, preferring the weekly one, and lists both on hover", () => {
    fixture.report = { fetchedAt: "now", providers: [{
      id: "claude", name: "Claude", driver: "claude", plan: null, ok: true, error: null,
      fiveHour: { available: true, remainingPercent: 84, usedPercent: 16, resetsAt: null },
      weekly: { available: true, remainingPercent: 83, usedPercent: 17, resetsAt: null }, extra: [],
    }] };
    const html = render([]);
    expect(html).toContain("17%");
    expect(html).toContain(">Weekly<");
    expect(html).toContain('title="Claude · 5-hour: 16% used · Weekly: 17% used"');
    expect(html).toContain('aria-label="Claude, Weekly"');
  });

  it("omits a provider's bar when it has reported no usable window", () => {
    fixture.report = { fetchedAt: "now", providers: [{
      id: "claude", name: "Claude", driver: "claude", plan: null, ok: false, error: "Sign in again.",
      fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
      weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [],
    }] };
    const html = render([]);
    expect(html).not.toContain('role="meter"');
  });

  it("hides the department filter when there is only one department", () => {
    const html = render([], { sectionOptions: [{ key: "", name: "General" }] });
    expect(html).not.toContain("<select");
  });

  it("offers every department plus an all-departments option, keeping the unsectioned team's own key distinct", () => {
    const html = render([], { sectionOptions: [{ key: "", name: "General" }, { key: "eng", name: "Engineering" }] });
    expect(html).toContain("All departments");
    expect(html).toContain("General");
    expect(html).toContain("Engineering");
  });

  it("marks the Live toggle pressed and labels the opposite action in its hint", () => {
    const on = render([], { live: true });
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("Pause automatic refresh");
    const off = render([], { live: false });
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain("Resume automatic refresh");
  });
});
