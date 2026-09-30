// Decision model is its own top-level Settings item, findable by what people
// would type for it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";

beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {};
  (globalThis as { document?: unknown }).document ??= { documentElement: { dataset: {} } };
});

vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => {},
}));

describe("Settings → Decision model", () => {
  it("is a sidebar item of its own, not a row under Connections", async () => {
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(SettingsModal)));
    expect(html).toContain('<option value="decisionModel">Decision model</option>');
    expect(html).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?Decision model<\/button>/);
  });

  it("matches searches for decision, jev, typesafe, routing and auto", async () => {
    const { SECTIONS, sectionMatches } = await import("./SettingsModal");
    const section = SECTIONS.find((entry) => entry.id === "decisionModel")!;
    for (const query of ["decision", "jev", "typesafe", "routing", "auto"]) expect(sectionMatches(section, query)).toBe(true);
    expect(sectionMatches(section, "backups")).toBe(false);
  });
});
