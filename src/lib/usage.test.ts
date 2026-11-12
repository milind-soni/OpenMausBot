import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageRingGraphic } from "../components/UsageRingGraphic";
import { RING_CIRCUMFERENCE, ringOffset, usageLabel, usageView, urgentUsage } from "./usage";
import type { EngineUsage } from "../../server/usage-types";
const now = Date.parse("2026-11-12T12:00:00Z");
const engine = (pct: number | null): EngineUsage => ({ instanceId: "c", updatedAt: new Date(now).toISOString(), status: pct === null ? "unknown" : pct === 0 ? "exhausted" : pct <= 40 ? "low" : "ok", source: "reported", windows: [{ id: "p", label: "Current allowance", remainingPercent: pct, resetsAt: "2026-11-12T15:00:00Z" }] });
describe("usage ring rendering and accessible labels", () => {
  it.each([[0, "exhausted"], [15, "low"], [40, "low"], [100, "ok"], [null, "unknown"], [9, "critical"]] as const)("renders %s as %s with distinct geometry", (pct, tone) => {
    const view = usageView(engine(pct), now);
    expect(view.tone).toBe(tone);
    expect(ringOffset(pct)).toBeCloseTo(RING_CIRCUMFERENCE * (1 - (pct ?? 0) / 100));
    const markup = renderToStaticMarkup(createElement(UsageRingGraphic, { driverKind: "codex", ...view }));
    expect(markup).toContain('aria-hidden="true"');
    if (tone === "unknown") expect(markup).toContain('stroke-dasharray="2.5 2.5"');
    if (tone === "critical" || tone === "exhausted") expect(markup).toContain("!</span>");
    const label = usageLabel("Codex", engine(pct), now);
    expect(label).toContain("Codex usage");
    expect(label).toContain(pct === null ? "not reported" : pct === 0 ? "ran out" : `${pct} percent left`);
    if (pct !== null) expect(label).toContain("refreshes at");
  });
  it("chooses the tightest known app before unknown and makes stale percentages unknown", () => {
    const items = [{ usage: engine(null) }, { usage: engine(100) }, { usage: engine(9) }, { usage: engine(0) }];
    expect(urgentUsage(items, now)).toBe(items[3]);
    expect(usageView(engine(70), now + 16 * 60_000).tone).toBe("unknown");
    expect(usageView({ ...engine(70), windows: [{ ...engine(70).windows[0], resetsAt: "2026-11-12T11:00:00Z" }] }, now).tone).toBe("unknown");
  });
});
