import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  state: {} as Record<string, unknown>,
  toolsLayout: "rows" as "rows" | "toolbar",
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarToolsLayout: () => fixture.toolsLayout,
}));
import { SidebarFooterNav } from "./SidebarFooterNav";

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
  fixture.toolsLayout = "rows";
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
    expect(html).toContain(">Team map</span>");
    expect(html.match(/>Tools</g) ?? []).toHaveLength(1);
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

  it("shows a collapse toggle above the rows outside icon density", () => {
    const { html } = render("comfortable");
    expect(html).toContain('data-testid="sidebar-footer-tools-toggle"');
  });

  it("hides the rows but keeps the toggle when collapsed", () => {
    let tree!: ReturnType<typeof SidebarFooterNav>;
    function Capture() {
      tree = SidebarFooterNav({ density: "comfortable", collapsed: true, onToggle: vi.fn() });
      return tree;
    }
    const html = renderToStaticMarkup(createElement(Capture));
    expect(html).toContain('data-testid="sidebar-footer-tools-toggle"');
    expect(html).not.toContain('data-sidebar-nav="routines"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("toggles from the collapse control", () => {
    const onToggle = vi.fn();
    let tree!: ReturnType<typeof SidebarFooterNav>;
    function Capture() {
      tree = SidebarFooterNav({ density: "comfortable", collapsed: false, onToggle });
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    const toggle = nodes(tree).find((node) => node.props["data-testid"] === "sidebar-footer-tools-toggle")!;
    (toggle.props.onClick as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("disables the toggle and ignores collapsed in icon density", () => {
    let tree!: ReturnType<typeof SidebarFooterNav>;
    function Capture() {
      tree = SidebarFooterNav({ density: "icons", collapsed: true, onToggle: vi.fn() });
      return tree;
    }
    const html = renderToStaticMarkup(createElement(Capture));
    expect(html).not.toContain('data-testid="sidebar-footer-tools-toggle"');
    expect(html).toContain('data-sidebar-nav="routines"');
  });

  it.each(["rows", "toolbar"] as const)("shows the Tools header outside icon density (%s)", (layout) => {
    fixture.toolsLayout = layout;
    for (const density of ["comfortable", "compact"] as const) {
      const { html } = render(density);
      expect(html).toContain(">Tools</span>");
      expect(html).toContain('class="lucide lucide-wrench shrink-0"');
    }
  });

  it.each(["rows", "toolbar"] as const)("hides the Tools header in icon density (%s)", (layout) => {
    fixture.toolsLayout = layout;
    const { html } = render("icons");
    expect(html).not.toContain(">Tools</span>");
    expect(html).not.toContain("lucide-wrench");
  });

  it.each(["comfortable", "compact"] as const)(
    "toolbar renders the places as icon buttons with labels (%s)",
    (density) => {
      fixture.toolsLayout = "toolbar";
      const { html } = render(density);
      for (const label of ["Routines", "Triggers", "Apps"]) {
        expect(html).toContain(`aria-label="${label}" title="${label}"`);
        expect(html).not.toContain(`>${label}</span>`);
      }
      expect(html).toContain('class="flex flex-row gap-1"');
    },
  );

  it("toolbar keeps tour anchors and aria-current", () => {
    fixture.advanced = true;
    fixture.toolsLayout = "toolbar";
    fixture.state.activeView = "routines";
    const { html } = render("comfortable");
    expect(html).toContain('data-tour="tools"');
    expect(html).toMatch(/data-tour="nav-automations" data-sidebar-nav="routines"/);
    expect(html).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"/);
    expect(html).toMatch(/data-tour="team-tools" data-sidebar-nav="team-map"/);
    expect(html).toContain('aria-current="page"');
  });

  it.each(["rows", "toolbar"] as const)("keeps the routines attention dot inside Routines (%s)", (layout) => {
    fixture.toolsLayout = layout;
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1 }];
    const { html } = render("comfortable");
    expect(html.indexOf('data-testid="routines-attention"')).toBeGreaterThan(html.indexOf('data-sidebar-nav="routines"'));
    expect(html.indexOf('data-testid="routines-attention"')).toBeLessThan(html.indexOf('data-sidebar-nav="triggers"'));
  });

  it.each(["rows", "toolbar"] as const)("shows no attention dot without a failed routine (%s)", (layout) => {
    fixture.toolsLayout = layout;
    fixture.state.routineRuns = [];
    const { html } = render("comfortable");
    expect(html).not.toContain('data-testid="routines-attention"');
  });

  it("toolbar keeps the collapse toggle and hides the tools when collapsed", () => {
    fixture.toolsLayout = "toolbar";
    let tree!: ReturnType<typeof SidebarFooterNav>;
    function Capture() {
      tree = SidebarFooterNav({ density: "comfortable", collapsed: true, onToggle: vi.fn() });
      return tree;
    }
    const html = renderToStaticMarkup(createElement(Capture));
    expect(html).toContain('data-testid="sidebar-footer-tools-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-sidebar-nav="routines"');
  });

  it("icons density ignores the toolbar layout", () => {
    fixture.toolsLayout = "rows";
    const rows = render("icons").html;
    fixture.toolsLayout = "toolbar";
    const toolbar = render("icons").html;
    expect(toolbar).toBe(rows);
  });

  it.each([
    ["rows", false],
    ["rows", true],
    ["toolbar", false],
    ["toolbar", true],
  ] as const)("shows Team map only in Advanced mode (%s layout, advanced %s)", (layout, advanced) => {
    fixture.toolsLayout = layout;
    fixture.advanced = advanced;
    const { html } = render("comfortable");
    for (const id of ["routines", "triggers", "apps"]) expect(html).toContain(`data-sidebar-nav="${id}"`);
    if (advanced) {
      expect(html).toContain('data-sidebar-nav="team-map"');
    } else {
      expect(html).not.toContain('data-sidebar-nav="team-map"');
    }
    expect(html.includes(">Team map<")).toBe(advanced && layout === "rows");
  });
});
