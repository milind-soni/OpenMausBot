import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";

beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {};
  (globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } };
});

// Pinned to Advanced: these cover the Advanced rail; Simple has its own suite.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => {},
}));

describe("Settings → Decision and extraction", () => {
  it("is a sidebar item of its own, not a row under Connections", async () => {
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(SettingsModal)));
    expect(html).toContain('<option value="decisionModel">Decision and extraction</option>');
    expect(html).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?Decision and extraction<\/button>/);
  });

  it("matches searches for decision, extraction, jev, typesafe, cloudflare, routing and auto", async () => {
    const { SECTIONS, sectionMatches } = await import("./SettingsModal");
    const section = SECTIONS.find((entry) => entry.id === "decisionModel")!;
    for (const query of ["decision", "extraction", "jev", "typesafe", "cloudflare", "workers ai", "routing", "auto"]) expect(sectionMatches(section, query)).toBe(true);
    expect(sectionMatches(section, "backups")).toBe(false);
  });
});
