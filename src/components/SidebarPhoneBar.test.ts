import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { activeView: "chat", pluginsOpen: false }, dispatch: () => {} }) }));
vi.mock("lucide-react", () => ({
  FolderKanban: () => null, FolderOpen: () => null, LayoutGrid: () => null, Puzzle: () => null,
  Rocket: () => null, Search: () => null, UsersRound: () => null, X: () => null, Zap: () => null,
}));
vi.mock("@/lib/cloud-files", () => ({ useCloudFilesReady: () => false }));
vi.mock("./CloudRoomCard", () => ({ CloudRoomCard: () => null }));
vi.mock("./CloudUsageMeter", () => ({ CloudUsageCard: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
vi.mock("./SidebarFooterNav", () => ({ useAutomationsNeedYou: () => false }));
vi.mock("./SidebarPopoverMenu", () => ({
  SidebarPopoverMenu: ({ items }: { items: { key: string }[] }) =>
    createElement("div", { "data-items": items.map((item) => item.key).join(",") }),
}));

import { SidebarPhoneBar } from "./SidebarPhoneBar";

describe("the phone tools menu", () => {
  it("keeps the project board reachable next to automations", () => {
    const html = renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {} }));
    expect(html).toContain('data-items="automations,project-board,team-map,published-apps,apps"');
  });
});
