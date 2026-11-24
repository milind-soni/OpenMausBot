// Settings → Features: Skill Burger off takes its chat card, its menu entries, its page and the bot panel's saved list
// away; thread notes off takes the "Saved to this thread" line away; mascot animations off holds mascots still. Nothing
// saved is touched, so on brings it all back.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

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
const { StatusActivityRow } = await import("../StatusActivityRow");
const { setDeviceFeature } = await import("@/lib/feature-switches");

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
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

describe("the thread notes switch", () => {
  const saved = { id: "m1", role: "bot", kind: "activity", at: "2026-11-24T10:00:00.000Z", text: "", tool: { name: "notice: Saved to this thread", nameCode: "chat.notice.savedToThread", ok: true } } as unknown as Message;
  const line = () => renderToStaticMarkup(createElement(StatusActivityRow, { message: saved }));

  it("shows the Saved to this thread line by default, hides it while off, and brings it back on", () => {
    expect(line()).toContain("data-saved-to-thread");
    setDeviceFeature("threadNotes", false);
    expect(line()).toBe("");
    setDeviceFeature("threadNotes", true);
    expect(line()).toContain("Saved to this thread");
  });
});

describe("the mascot animations switch", () => {
  it("holds mascots still while off, as reduced motion does, and lets them move again once on", async () => {
    const { useMascotStill } = await import("../mascot-clock");
    const Probe = () => createElement("i", null, String(useMascotStill()));
    const still = () => renderToStaticMarkup(createElement(Probe));
    expect(still()).toBe("<i>false</i>");
    setDeviceFeature("mascotMotion", false);
    expect(still()).toBe("<i>true</i>");
    setDeviceFeature("mascotMotion", true);
    expect(still()).toBe("<i>false</i>");
  });
});
