import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarDensity, SidebarToolsLayout } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  state: {} as Record<string, unknown>,
  toolsLayout: "rows" as SidebarToolsLayout,
  panels: [] as { id: string; name: string; url: string }[],
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarToolsLayout: () => fixture.toolsLayout,
}));
vi.mock("@/lib/web-panel-preferences", () => ({ useWebPanels: () => fixture.panels }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
import { SidebarAppsButton, SidebarBottomButtons, SidebarFooterNav } from "./SidebarFooterNav";

type Props = { children?: ReactNode; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as ReactElement<Props>;
    return [node, ...nodes(node.props.children)];
  });
}
function render(density: SidebarDensity, { toolsLayout = "rows", ...extra }: { collapsed?: boolean; onToggleCollapsed?: () => void; toolsLayout?: SidebarToolsLayout } = {}) {
  fixture.toolsLayout = toolsLayout;
  let tree!: ReturnType<typeof SidebarFooterNav>;
  function Capture() { tree = SidebarFooterNav({ density, onToggleCollapsed: () => {}, ...extra }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

beforeEach(() => {
  fixture.advanced = false;
  fixture.dispatch.mockReset();
  fixture.state = { activeView: "chat", routineRuns: [], pluginsOpen: false };
  fixture.toolsLayout = "rows";
  fixture.panels = [];
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("sidebar footer places", () => {
  it.each(["comfortable", "compact"] as const)("leads Advanced mode's places with Automations, then Team map, with Apps beside the profile instead (%s)", (density) => {
    fixture.advanced = true;
    const { html } = render(density);
    const order = ["automations", "team-map"].map((id) => html.indexOf(`data-sidebar-nav="${id}"`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain(">Automations</span>");
    expect(html).not.toContain('data-sidebar-nav="routines"');
    expect(html).not.toContain('data-sidebar-nav="triggers"');
    expect(html).not.toContain('data-sidebar-nav="apps"');
  });

  it.each(["comfortable", "compact"] as const)("leaves no places in Simple mode's sidebar while Files is off: Automations and Team map are in the bottom bar (%s)", (density) => {
    expect(render(density).html).toBe("");
  });

  it.each([false, true])("puts Automations on the avatars-only density ahead of Apps, with Team map (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const html = render("icons").html;
    expect(html).toContain('aria-label="Automations" title="Automations"');
    expect(html).toContain('aria-label="Team map" title="Team map"');
    expect(html.indexOf('data-sidebar-nav="automations"')).toBeLessThan(html.indexOf('data-sidebar-nav="apps"'));
  });

  it("keeps only Apps on Simple mode's rail: Automations and Team map are in its account menu", () => {
    const html = renderToStaticMarkup(createElement(() => SidebarFooterNav({ density: "icons", rail: true })));
    expect(html).toContain('aria-label="Apps" title="Apps"');
    expect(html).toContain('data-tour="tools"');
    expect(html).not.toContain('data-sidebar-nav="automations"');
    expect(html).not.toContain('data-sidebar-nav="team-map"');
  });

  it("opens the Automations page through the store, and marks it current while open", () => {
    fixture.advanced = true;
    const { nodes: tree } = render("comfortable");
    (tree.find((node) => node.props.id === "automations" && typeof node.props.onClick === "function")!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines", view: "list" });
    fixture.state.activeView = "routines";
    expect(render("comfortable").html).toMatch(/data-sidebar-nav="automations"[^>]*aria-current="page"/);
  });

  it("adds a row per pinned web panel after Team map, in Advanced mode only", () => {
    fixture.panels = [{ id: "panel-1", name: "Fleet board", url: "http://127.0.0.1:7841/" }];
    fixture.state = { ...fixture.state, activeView: "web-panel", webPanelId: "panel-1" };
    expect(render("comfortable").html).toBe("");
    fixture.advanced = true;
    const { html, nodes: tree } = render("comfortable");
    expect(html.indexOf('data-sidebar-nav="web-panel-panel-1"')).toBeGreaterThan(html.indexOf('data-sidebar-nav="team-map"'));
    expect(html).toContain(">Fleet board</span>");
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*Fleet board/);
    const row = tree.find((node) => node.props.id === "web-panel-panel-1" && typeof node.props.onClick === "function")!;
    (row.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showWebPanel", id: "panel-1" });
  });

  it("shows a pinned panel as an icon with its name as the label in the toolbar layout", () => {
    fixture.advanced = true;
    fixture.panels = [{ id: "panel-1", name: "Fleet board", url: "http://127.0.0.1:7841/" }];
    const { html } = render("comfortable", { toolsLayout: "toolbar" });
    expect(html).toContain('data-sidebar-nav="web-panel-panel-1"');
    expect(html).not.toContain(">Fleet board</span>");
    expect(html).toContain('aria-label="Fleet board"');
  });

  it("keeps the guided tour's anchors on the rows", () => {
    fixture.advanced = true;
    const { html } = render("comfortable");
    expect(html).toContain('data-tour="tools"');
    expect(html).toMatch(/data-tour="nav-automations" data-sidebar-nav="automations"/);
  });

  it("carries the dot for an unseen failed run on Automations, and clears it once seen", () => {
    fixture.advanced = true;
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1 }];
    const html = render("comfortable").html;
    expect(html.indexOf('data-testid="routines-attention"')).toBeGreaterThan(html.indexOf('data-sidebar-nav="automations"'));
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1, seenAt: 1 }];
    expect(render("comfortable").html).not.toContain('data-testid="routines-attention"');
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
    for (const label of ["Automations", "Team map"]) {
      expect(html).toContain(`aria-label="${label}" title="${label}"`);
      expect(html).not.toContain(`>${label}</span>`);
    }
  });
});

describe("Tools header", () => {
  it.each(["comfortable", "compact"] as const)("labels the places with a Tools header, expanded by default (%s)", (density) => {
    fixture.advanced = true;
    const { html } = render(density);
    expect(html).toContain(">Tools<");
    expect(html).toContain('aria-expanded="true"');
    expect(html.indexOf(">Tools<")).toBeLessThan(html.indexOf('data-sidebar-nav="automations"'));
    for (const id of ["automations", "team-map"]) expect(html).toContain(`data-sidebar-nav="${id}"`);
  });

  it("keeps the Tools label and hides the rows when collapsed", () => {
    fixture.advanced = true;
    const { html } = render("comfortable", { collapsed: true });
    expect(html).toContain(">Tools<");
    expect(html).toContain('aria-expanded="false"');
    for (const id of ["automations", "team-map"]) expect(html).not.toContain(`data-sidebar-nav="${id}"`);
  });

  it("toggles through the header", () => {
    fixture.advanced = true;
    const onToggleCollapsed = vi.fn();
    const { nodes: tree } = render("comfortable", { onToggleCollapsed });
    const header = tree.find((node) => typeof node.props.onToggle === "function")!;
    (header.props.onToggle as () => void)();
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("shows the failed-run dot on the header only while collapsed", () => {
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
    expect(render("comfortable").html).not.toContain(">Tools<");
  });

  it("keeps the guided tour's tools anchor on the header and rows together", () => {
    fixture.advanced = true;
    expect(render("comfortable").html).toContain('data-tour="tools"');
    expect(render("comfortable", { collapsed: true }).html).toContain('data-tour="tools"');
  });
});

function renderBottom() {
  let tree!: ReturnType<typeof SidebarBottomButtons>;
  function Capture() { tree = SidebarBottomButtons(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
describe("the bottom bar beside the profile", () => {
  it.each([false, true])("carries Apps alone: Automations and Team map are Tools rows in Advanced and account menu items in Simple (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const { html } = renderBottom();
    expect(html).not.toContain('data-sidebar-nav="automations"');
    expect(html).not.toContain('data-sidebar-nav="team-map"');
    expect(html).toContain('data-sidebar-nav="apps"');
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

describe("toolbar tools layout", () => {
  it.each(["comfortable", "compact"] as const)("toolbar renders the places as icon buttons with labels (%s)", (density) => {
    fixture.advanced = true;
    const { html } = render(density, { toolsLayout: "toolbar" });
    expect(html).toContain('class="flex flex-row gap-1"');
    expect(html).not.toContain("flex-col");
    for (const label of ["Automations", "Team map"]) {
      expect(html).toContain(`aria-label="${label}" title="${label}"`);
      expect(html).not.toContain(`>${label}</span>`);
    }
  });

  it("toolbar keeps tour anchors and aria-current", () => {
    fixture.advanced = true;
    fixture.state.activeView = "routines";
    const { html } = render("comfortable", { toolsLayout: "toolbar" });
    expect(html).toContain('data-tour="tools"');
    expect(html).toMatch(/data-tour="nav-automations" data-sidebar-nav="automations"/);
    expect(html).toMatch(/data-tour="team-tools" data-sidebar-nav="team-map"/);
    const place = (id: string) => {
      const at = html.indexOf(`data-sidebar-nav="${id}"`);
      const next = html.indexOf("data-sidebar-nav=", at + 1);
      return html.slice(at, next === -1 ? undefined : next);
    };
    expect(place("automations")).toContain('aria-current="page"');
    expect(place("team-map")).not.toContain('aria-current="page"');
  });

  it("toolbar shows the failed-run dot and clears it once seen", () => {
    fixture.advanced = true;
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1 }];
    expect(render("comfortable", { toolsLayout: "toolbar" }).html).toContain('data-testid="routines-attention"');
    fixture.state.routineRuns = [{ id: "r", status: "failed", scheduledFor: 1, seenAt: 1 }];
    expect(render("comfortable", { toolsLayout: "toolbar" }).html).not.toContain('data-testid="routines-attention"');
  });

  it("toolbar applies to Advanced mode's two places; Simple mode keeps them in the bottom bar instead", () => {
    fixture.advanced = true;
    expect(render("comfortable", { toolsLayout: "toolbar" }).html.match(/data-sidebar-nav="/g)).toHaveLength(2);
    fixture.advanced = false;
    expect(render("comfortable", { toolsLayout: "toolbar" }).html).toBe("");
  });

  it("icons density ignores the tools layout", () => {
    fixture.advanced = true;
    const rows = render("icons").html;
    expect(render("icons", { toolsLayout: "toolbar" }).html).toBe(rows);
    expect(rows).toContain('class="flex flex-col items-center gap-1"');
  });

  it("rows layout renders exactly as before", () => {
    fixture.advanced = true;
    const unset = render("comfortable").html;
    expect(render("comfortable", { toolsLayout: "rows" }).html).toBe(unset);
    expect(unset).toContain('<div data-tour="tools">');
    expect(unset).toContain('<nav aria-label="Tools" class="flex flex-col gap-0.5">');
    expect(unset).not.toContain("flex-row");
    for (const label of ["Automations", "Team map"]) {
      expect(unset).toContain(`>${label}</span>`);
      expect(unset).not.toContain(`title="${label}"`);
      expect(unset).not.toContain(`aria-label="${label}"`);
    }
  });
});
