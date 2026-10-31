import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ report: null as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial === null ? fixture.report : initial === true ? false : typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
}));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
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
});
