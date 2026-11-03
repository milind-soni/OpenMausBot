import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: () => {} }) }));
vi.mock("./SidebarPlanUsage", () => ({ SidebarPlanUsage: () => createElement("i", { "data-plan-meter": "" }) }));
vi.mock("./AccountMove", () => ({ AccountMoveStatus: () => null, useAccountMoveLine: () => ({}) }));
vi.mock("./CloudRoomCard", () => ({ CloudRoomCard: () => null }));
vi.mock("./CloudUsageMeter", () => ({ CloudUsageCard: () => null }));
vi.mock("./DesktopWorkspaceSwitcher", () => ({ endCloudHowTo: () => {}, useWorkspacePlace: () => ({}) }));
vi.mock("./SidebarConnectApps", () => ({ SidebarConnectApps: () => null }));
vi.mock("./SidebarFooterNav", () => ({ SidebarBottomButtons: () => null, SidebarFooterNav: () => null }));
vi.mock("./SidebarPhoneButton", () => ({ phoneSettingsAction: () => ({}), SidebarPhoneButton: () => null }));
vi.mock("./SidebarProfileMenu", () => ({ SidebarProfileMenu: () => null, useSimpleAccount: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

const { setSidebarPlanUsage } = await import("@/lib/sidebar-preferences");
const { SidebarFooter } = await import("./SidebarFooter");

const footer = (simple: boolean) =>
  renderToStaticMarkup(createElement(SidebarFooter, { density: "comfortable", simple, toolsCollapsed: false }));

describe("the plan usage meter in the sidebar footer", () => {
  beforeEach(() => setSidebarPlanUsage(true));

  it("shows in Advanced and never in Simple", () => {
    expect(footer(false)).toContain("data-plan-meter");
    expect(footer(true)).not.toContain("data-plan-meter");
  });

  it("goes away from Advanced once the person hides it", () => {
    setSidebarPlanUsage(false);
    expect(footer(false)).not.toContain("data-plan-meter");
  });
});
