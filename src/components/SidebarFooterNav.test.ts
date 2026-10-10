import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  state: {} as Record<string, unknown>,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
import { SidebarAppsButton, SidebarFooterNav } from "./SidebarFooterNav";

type Props = { children?: ReactNode; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as ReactElement<Props>;
    return [node, ...nodes(node.props.children)];
  });
}
function render(density: SidebarDensity, extra: { collapsed?: boolean; onToggleCollapsed?: () => void } = {}) {
  let tree!: ReturnType<typeof SidebarFooterNav>;
  function Capture() { tree = SidebarFooterNav({ density, onToggleCollapsed: () => {}, ...extra }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

beforeEach(() => {
  fixture.advanced = false;
  fixture.dispatch.mockReset();
  fixture.state = { activeView: "chat", routineRuns: [], triggersOpen: false, pluginsOpen: false };
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("sidebar footer places", () => {
  it.each(["comfortable", "compact"] as const)("shows Routines and Triggers as direct rows in Advanced mode, with Apps beside the profile instead (%s)", (density) => {
    fixture.advanced = true;
    const { html } = render(density);
    const order = ["routines", "triggers", "team-map"].map((id) => html.indexOf(`data-sidebar-nav="${id}"`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const label of ["Routines", "Triggers"]) expect(html).toContain(`>${label}</span>`);
    expect(html).not.toContain('data-sidebar-nav="apps"');
  });

  it.each(["comfortable", "compact"] as const)("draws no place rows at all in Simple mode (%s)", (density) => {
    const { html } = render(density);
    expect(html).toBe("");
  });

  it("keeps Simple mode's Apps on the avatars-only rail, without Routines or Triggers", () => {
    const { html } = render("icons");
    expect(html).toContain('aria-label="Apps" title="Apps"');
    expect(html).not.toContain('data-sidebar-nav="routines"');
    expect(html).not.toContain('data-sidebar-nav="triggers"');
  });

  it("opens each place through the store", () => {
    fixture.advanced = true;
    const { nodes: tree } = render("comfortable");
    const row = (id: string) => tree.find((node) => node.props.id === id && typeof node.props.onClick === "function")!;
    (row("routines").props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines" });
    (row("triggers").props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleTriggers", open: true });
  });

  it("keeps the guided tour's anchors on the rows", () => {
    fixture.advanced = true;
    const { html } = render("comfortable");
    expect(html).toContain('data-tour="tools"');
    expect(html).toMatch(/data-tour="nav-automations" data-sidebar-nav="routines"/);
  });

  it("keeps the failed-routine dot on Routines", () => {
    fixture.advanced = true;
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1 }];
    const { html } = render("comfortable");
    expect(html.indexOf('data-testid="routines-attention"')).toBeGreaterThan(html.indexOf('data-sidebar-nav="routines"'));
    expect(html.indexOf('data-testid="routines-attention"')).toBeLessThan(html.indexOf('data-sidebar-nav="triggers"'));
  });

  it("shows Team map as its own row in Advanced mode, with no Tools menu", () => {
    fixture.advanced = true;
    const { nodes: tree, html } = render("comfortable");
    expect(html).toContain(">Team map</span>");
    expect(html).not.toContain("aria-haspopup");
    const row = tree.find((node) => node.props.id === "team-map")!;
    (row.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showTeamMap" });
  });

  it("draws icons with tooltips in the avatars-only density", () => {
    fixture.advanced = true;
    const { html } = render("icons");
    for (const label of ["Routines", "Triggers", "Apps", "Team map"]) {
      expect(html).toContain(`aria-label="${label}" title="${label}"`);
      expect(html).not.toContain(`>${label}</span>`);
    }
  });
});

describe("Tools header", () => {
  it.each(["comfortable", "compact"] as const)("labels the three places with a Tools header, expanded by default (%s)", (density) => {
    fixture.advanced = true;
    const { html } = render(density);
    expect(html).toContain(">Tools<");
    expect(html).toContain('aria-expanded="true"');
    expect(html.indexOf(">Tools<")).toBeLessThan(html.indexOf('data-sidebar-nav="routines"'));
    for (const id of ["routines", "triggers", "team-map"]) expect(html).toContain(`data-sidebar-nav="${id}"`);
  });

  it("keeps the Tools label and hides the rows when collapsed", () => {
    fixture.advanced = true;
    const { html } = render("comfortable", { collapsed: true });
    expect(html).toContain(">Tools<");
    expect(html).toContain('aria-expanded="false"');
    for (const id of ["routines", "triggers", "team-map"]) expect(html).not.toContain(`data-sidebar-nav="${id}"`);
  });

  it("toggles through the header", () => {
    fixture.advanced = true;
    const onToggleCollapsed = vi.fn();
    const { nodes: tree } = render("comfortable", { onToggleCollapsed });
    const header = tree.find((node) => typeof node.props.onToggle === "function")!;
    (header.props.onToggle as () => void)();
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("shows the failed-routine dot on the header only while collapsed", () => {
    fixture.advanced = true;
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1 }];
    const collapsed = render("comfortable", { collapsed: true }).html;
    expect(collapsed).toContain('data-testid="section-alert"');
    expect(collapsed).not.toContain('data-testid="routines-attention"');
    const expanded = render("comfortable").html;
    expect(expanded).not.toContain('data-testid="section-alert"');
    expect(expanded).toContain('data-testid="routines-attention"');
  });

  it("shows no dot on a collapsed header when nothing needs you", () => {
    fixture.advanced = true;
    expect(render("comfortable", { collapsed: true }).html).not.toContain('data-testid="section-alert"');
  });

  it("draws no Tools header in the avatars-only density or in Simple mode", () => {
    fixture.advanced = true;
    expect(render("icons").html).not.toContain(">Tools<");
    fixture.advanced = false;
    expect(render("comfortable").html).toBe("");
  });

  it("keeps the guided tour's tools anchor on the header and rows together", () => {
    fixture.advanced = true;
    expect(render("comfortable").html).toContain('data-tour="tools"');
    expect(render("comfortable", { collapsed: true }).html).toContain('data-tour="tools"');
  });
});

describe("Apps beside the profile", () => {
  it.each([false, true])("is one icon button that opens Apps and carries the tour's Apps anchor (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    let tree!: ReturnType<typeof SidebarAppsButton>;
    function Capture() { tree = SidebarAppsButton(); return tree; }
    const html = renderToStaticMarkup(createElement(Capture));
    expect(html).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"/);
    expect(html).toContain('aria-label="Apps"');
    (tree.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true });
  });
});
