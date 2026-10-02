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
import { SidebarFooterNav } from "./SidebarFooterNav";
import { SidebarMoreMenu } from "./SidebarMoreMenu";

type Props = { children?: ReactNode; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as ReactElement<Props>;
    return [node, ...nodes(node.props.children)];
  });
}
function render(density: SidebarDensity) {
  let tree!: ReturnType<typeof SidebarFooterNav>;
  function Capture() { tree = SidebarFooterNav({ density }); return tree; }
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
  it.each(["comfortable", "compact"] as const)("shows Routines, Triggers and Apps as direct rows (%s)", (density) => {
    const { html } = render(density);
    const order = ["routines", "triggers", "apps"].map((id) => html.indexOf(`data-sidebar-nav="${id}"`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const label of ["Routines", "Triggers", "Apps"]) expect(html).toContain(`>${label}</span>`);
    // the hover Tools menu is gone in Simple mode
    expect(html).not.toContain("Team map");
  });

  it("opens each place through the store", () => {
    const { nodes: tree } = render("comfortable");
    const row = (id: string) => tree.find((node) => node.props.id === id && typeof node.props.onClick === "function")!;
    (row("routines").props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines" });
    (row("triggers").props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleTriggers", open: true });
    (row("apps").props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true });
  });

  it("keeps the guided tour's anchors on the new rows", () => {
    const { html } = render("comfortable");
    expect(html).toContain('data-tour="tools"');
    expect(html).toMatch(/data-tour="nav-automations" data-sidebar-nav="routines"/);
    expect(html).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"/);
  });

  it("keeps the failed-routine dot on Routines", () => {
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1 }];
    const { html } = render("comfortable");
    expect(html.indexOf('data-testid="routines-attention"')).toBeGreaterThan(html.indexOf('data-sidebar-nav="routines"'));
    expect(html.indexOf('data-testid="routines-attention"')).toBeLessThan(html.indexOf('data-sidebar-nav="triggers"'));
  });

  it("shows Team map as its own row in Advanced mode, with no Tools menu", () => {
    fixture.advanced = true;
    const { nodes: tree, html } = render("comfortable");
    expect(tree.some((node) => node.type === SidebarMoreMenu)).toBe(false);
    expect(html).toContain(">Team map</span>");
    expect(html).not.toContain(">Tools<");
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
