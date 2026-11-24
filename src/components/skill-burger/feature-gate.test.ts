// Settings → Features: Skill Burger off takes its chat card, its menu entries, its page and the bot panel's saved list
// away. Nothing saved is touched, so on brings it all back.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { skillBurgerEnabled, threadTabsEnabled } from "@/lib/feature-flags";

const fixture = vi.hoisted(() => ({ config: {} as Record<string, unknown>, items: [] as Array<{ key: string }> }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: fixture.config, activeView: "chat", pluginsOpen: false, bots: [] }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/cloud-files", () => ({ useCloudFilesReady: () => false }));
vi.mock("../SidebarFooterNav", () => ({ useAutomationsNeedYou: () => false }));
vi.mock("../CloudRoomCard", () => ({ CloudRoomCard: () => null }));
vi.mock("../CloudUsageMeter", () => ({ CloudUsageCard: () => null }));
vi.mock("../UpdateIndicator", () => ({ UpdateIndicator: () => null }));
vi.mock("../SidebarPopoverMenu", () => ({ SidebarPopoverMenu: ({ items }: { items: Array<{ key: string }> }) => { fixture.items = items; return null; } }));

const { SidebarPhoneBar } = await import("../SidebarPhoneBar");

beforeEach(() => {
  fixture.config = {};
  fixture.items = [];
  setLocale("en");
});
afterEach(() => vi.unstubAllGlobals());

const phoneTools = () => {
  renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {} }));
  return fixture.items.map((item) => item.key);
};

describe("the Skill Burger switch", () => {
  it("is on, and thread tabs off, until the place's config.json says otherwise", () => {
    expect(skillBurgerEnabled(null)).toBe(true);
    expect(skillBurgerEnabled({ features: { skillBurger: false } })).toBe(false);
    expect(threadTabsEnabled(null)).toBe(false);
    expect(threadTabsEnabled({ features: { threadTabs: true } })).toBe(true);
  });

  it("shows Skill Burgers in the tools menu by default, hides it while off, and brings it back on", () => {
    expect(phoneTools()).toContain("skill-burgers");
    fixture.config = { features: { skillBurger: false } };
    expect(phoneTools()).not.toContain("skill-burgers");
    fixture.config = { features: { skillBurger: true } };
    expect(phoneTools()).toContain("skill-burgers");
  });

  it("gates every other way in at its call site", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source("../ChatView.tsx")).toMatch(/\{skillBurger && <SkillBurgerSlot /);
    expect(source("../../App.tsx")).toContain('state.activeView === "skill-burgers" && skillBurger ? (');
    expect(source("../SidebarProfileMenu.tsx")).toContain('onSkillBurgers: skillBurger ? () => dispatch({ type: "showSkillBurgers" }) : undefined,');
    expect(source("../bot-panel/pages.tsx")).toMatch(/\{skillBurger && <SavedWorkflowsCard /);
    for (const path of ["../ChatView.tsx", "../../App.tsx", "../SidebarProfileMenu.tsx", "../bot-panel/pages.tsx"]) {
      expect(source(path), path).toContain('skillBurger = useFeature("skillBurger")');
    }
  });
});
