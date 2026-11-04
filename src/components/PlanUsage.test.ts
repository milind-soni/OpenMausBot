import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ report: null as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial === null ? fixture.report : initial === true ? false : typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
}));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { setSidebarPlanUsage } from "@/lib/sidebar-preferences";
import { PlanUsage } from "./PlanUsage";

describe("Plan usage presentation", () => {
  it("distinguishes remaining account allowance, per-model usage, and unavailable windows", () => {
    fixture.report = {
      fetchedAt: "2026-10-02T09:00:00Z",
      providers: [{
        id: "fixture", name: "Fixture provider", driver: "claude", plan: "Pro", ok: true, error: null,
        fiveHour: { available: true, remainingPercent: 68, usedPercent: 32, resetsAt: null },
        weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [],
        models: [{ name: "Sonnet", windows: [{ label: "Weekly", remainingPercent: 30, usedPercent: 70, resetsAt: null }] }],
      }],
    };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("68% left");
    expect(html).toContain("70% used");
    expect(html).toContain("Not reported by this plan");
    expect(html).not.toContain("100% left");
    expect(html).toContain('aria-valuenow="32"');
    expect(html).toContain('aria-valuenow="70"');
  });

  it("shows a monthly budget's amounts beside how much of it is used", () => {
    fixture.report = {
      fetchedAt: "2026-10-02T09:00:00Z",
      providers: [{
        id: "fixture", name: "Fixture provider", driver: "claude", plan: "Enterprise", ok: true, error: null,
        fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
        extra: [{ label: "Monthly spend", remainingPercent: 90.7, usedPercent: 9.3, resetsAt: null, spend: { usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 } }],
        models: [],
      }],
    };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("Monthly spend");
    expect(html).toContain("9% used");
    expect(html).toContain("$46.31 of $500.00 spent");
    expect(html).toContain('aria-valuenow="9"');
  });

  it("names the monthly budget in the person's language", async () => {
    const { loadLocale, setLocale } = await import("@/lib/i18n");
    await loadLocale("zh");
    try {
      expect(renderToStaticMarkup(createElement(PlanUsage))).toContain("每月支出");
    } finally {
      setLocale("en");
    }
  });

  it("shows an account error without inventing zero usage", () => {
    fixture.report = { providers: [{ id: "fixture", name: "Fixture provider", ok: false, error: "Sign in to this account." }] };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("Sign in to this account.");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("100% left");
  });

  it("leaves out a Copilot engine nobody signed in to, but keeps a Copilot check that failed", () => {
    const copilot = (reason: string) => ({ id: `copilot-${reason}`, name: "GitHub Copilot", driver: "copilot", ok: false, reason, error: `Copilot ${reason}` });
    fixture.report = { providers: [copilot("signedOut"), copilot("noPlan"), copilot("failed")] };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).not.toContain("Copilot signedOut");
    expect(html).not.toContain("Copilot noPlan");
    expect(html).toContain("Copilot failed");
  });
});

describe("Usage & billing in Simple mode", () => {
  const provider = (id: string, ok: boolean, used: number | null) => ({
    id, name: id, driver: id, plan: null, ok, error: null, extra: [],
    fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
    weekly: { available: used !== null, remainingPercent: used === null ? null : 100 - used, usedPercent: used, resetsAt: null },
  });

  it("leads with the provider whose weekly allowance is most used, and ignores providers that report none or fail", async () => {
    const { busiestWeekly } = await import("./PlanUsage");
    expect(busiestWeekly({ providers: [provider("claude", true, 34), provider("codex", true, 61), provider("grok", false, 90), provider("kimi", true, null)] }))
      .toMatchObject({ provider: { id: "codex" }, used: 61 });
    expect(busiestWeekly({ providers: [provider("grok", false, 90)] })).toBeNull();
    expect(busiestWeekly(null)).toBeNull();
  });

  it("falls back to the fullest monthly allowance, such as Copilot's premium requests", async () => {
    const { busiestMonthly } = await import("./PlanUsage");
    const copilot = { ...provider("copilot", true, null), extra: [{ label: "Monthly", kind: "monthly" as const, usedPercent: 31, remainingPercent: 69, resetsAt: null }] };
    expect(busiestMonthly({ providers: [provider("claude", true, null), copilot] })).toMatchObject({ provider: { id: "copilot" }, extra: { usedPercent: 31 } });
    expect(busiestMonthly({ providers: [{ ...copilot, ok: false }] })).toBeNull();
  });

  it("stands a plan's monthly budget in for the weekly figure when it has none", async () => {
    const { monthlySpend } = await import("./PlanUsage");
    const budget = { label: "Monthly spend", remainingPercent: 91, usedPercent: 9, resetsAt: null };
    expect(monthlySpend({ providers: [{ ...provider("claude", true, null), extra: [budget] }] })).toMatchObject({ provider: { id: "claude" }, budget });
    expect(monthlySpend({ providers: [{ ...provider("claude", true, 40), extra: [budget] }] })).toBeNull();
    expect(monthlySpend({ providers: [{ ...provider("claude", false, null), extra: [budget] }] })).toBeNull();
    expect(monthlySpend(null)).toBeNull();
  });
});

describe("the sidebar switch on the plan usage card", () => {
  const switchOf = (markup: string) => /role="switch" aria-checked="(true|false)"/.exec(markup)?.[1];

  it("says whether the meter shows in the sidebar", () => {
    fixture.report = { fetchedAt: "2026-10-02T09:00:00Z", providers: [] };
    setSidebarPlanUsage(true);
    expect(switchOf(renderToStaticMarkup(createElement(PlanUsage)))).toBe("true");
    setSidebarPlanUsage(false);
    expect(switchOf(renderToStaticMarkup(createElement(PlanUsage)))).toBe("false");
  });

  it("names the switch by its visible label", () => {
    fixture.report = { fetchedAt: "2026-10-02T09:00:00Z", providers: [] };
    const markup = renderToStaticMarkup(createElement(PlanUsage));
    const id = /<button[^>]*id="([^"]+)"[^>]*role="switch"/.exec(markup)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`<label for="${id}"`);
  });
});
