import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { EngineCard, EngineSections, engineReady } from "./EngineLibrary";
import { CursorMark, HermesMark } from "./ProviderIcons";

const instance = (overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: true },
  models: { default: "test", options: [] }, ...overrides,
});

describe("engine library", () => {
  it("keeps monochrome provider logos legible in light and dark skins", () => {
    for (const Mark of [CursorMark, HermesMark]) {
      const html = renderToStaticMarkup(createElement(Mark));
      expect(html).not.toContain("#F5F5F5");
      expect(html).toContain("ink");
    }
  });
  it("preserves readiness semantics without mistaking installation for sign-in", () => {
    expect(engineReady(instance())).toBe(true);
    expect(engineReady(instance({ snapshot: { state: "available" } }))).toBe(true);
    expect(engineReady(instance({ snapshot: { state: "available", authenticated: false } }))).toBe(false);
    expect(engineReady(instance({ access: "custom", snapshot: { state: "available", authenticated: false } }))).toBe(true);
    expect(engineReady(instance({ access: "custom", snapshot: { state: "unavailable", authenticated: true } }))).toBe(false);
  });

  it("uses an accessible disclosure and keeps controls mounted while collapsed", () => {
    const html = renderToStaticMarkup(createElement(EngineCard, { instance: instance(), children: createElement("input", { "aria-label": "Path draft" }) }));
    expect(html).toContain('<details data-engine-card="claude"');
    expect(html).toContain("<summary");
    expect(html).toContain('aria-label="Path draft"');
    expect(html).toContain("focus-visible:ring-2");
    expect(html).not.toContain('open=""');
  });

  it("never displays a stale signed-out account identity", () => {
    const row = instance({ snapshot: { state: "available", authenticated: false, account: { email: "private@example.test" } } });
    const render = (value: InstanceInfo) => renderToStaticMarkup(createElement(EngineCard, { instance: value, children: null }));
    expect(render(row)).not.toContain("private@example.test");
    expect(render(row)).toContain("Needs setup");
    expect(render({ ...row, snapshot: { ...row.snapshot, authenticated: true } })).toContain("private@example.test");
  });

  it("does not present executable names as versions", () => {
    const render = (version: string) => renderToStaticMarkup(createElement(EngineCard, { instance: instance({ snapshot: { state: "available", version } }), children: null }));
    expect(render("claude")).not.toContain("vclaude");
    expect(render("Claude Code 2.1.8")).toContain("v2.1.8");
  });

  it("keeps cards under the same keyed parent when a refreshed status regroups them", () => {
    const other = instance({ instanceId: "work" }); // Duplicate display names are valid.
    const renderEngine = (value: InstanceInfo) => createElement(EngineCard, { instance: value, children: null });
    const ready = EngineSections({ instances: [instance(), other], renderEngine });
    const signedOut = EngineSections({ instances: [instance({ snapshot: { state: "available", authenticated: false } }), other], renderEngine });
    for (const tree of [ready, signedOut]) {
      expect(tree.type).toBe("div");
      // This parent/key contract prevents native disclosure state and React
      // form drafts from being discarded when authentication changes.
      const card = tree.props.children[0].find((node: { key: string }) => node.key === "claude");
      expect(card.type).toBe("div");
      expect(card.props.children.type).toBe(EngineCard);
      const html = renderToStaticMarkup(tree);
      expect(html.match(/data-engine-card=/g)).toHaveLength(2);
    }
  });
});
