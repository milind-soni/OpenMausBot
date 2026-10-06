import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SECTIONS, SETTINGS_GROUPS, SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "appearance" as AppSettingsSection,
  showThreads: true,
  setShowThreads: vi.fn(),
  showRunCard: true,
  setShowRunCard: vi.fn(),
  sidebarDensity: "comfortable" as "comfortable" | "compact" | "icons",
  setSidebarDensity: vi.fn(),
  notificationSounds: true,
  setNotificationSounds: vi.fn(),
  advancedMode: false,
  setAdvancedMode: vi.fn(),
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
  ownerOrAdmin: null as boolean | null,
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [] }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/thread-preferences", () => ({
  useShowThreads: () => fixture.showThreads,
  useShowThreadsChoice: () => fixture.showThreads,
  setShowThreads: fixture.setShowThreads,
}));
vi.mock("@/lib/run-card-preferences", () => ({
  useShowRunCard: () => fixture.showRunCard,
  setShowRunCard: fixture.setShowRunCard,
}));
vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.sidebarDensity,
  setSidebarDensity: fixture.setSidebarDensity,
}));
vi.mock("@/lib/notification-preferences", () => ({
  useNotificationSounds: () => fixture.notificationSounds,
  setNotificationSounds: fixture.setNotificationSounds,
}));
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advancedMode,
  setAdvancedMode: fixture.setAdvancedMode,
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("./SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return {
    ...original,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.switches.push(props);
      return createElement(original.Switch, props);
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "appearance";
  fixture.showThreads = true;
  fixture.showRunCard = true;
  fixture.sidebarDensity = "comfortable";
  fixture.notificationSounds = true;
  // these pin the Advanced rail; Simple has its own suite (SettingsModal.simple.test.ts)
  fixture.advancedMode = true;
  fixture.switches = [];
  fixture.ownerOrAdmin = null;
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));

const render = () => renderToStaticMarkup(createElement(SettingsModal));

/** The rail as drawn: each group with the section ids under it, in order. */
function rail(html: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  let current = "";
  for (const match of html.matchAll(/data-settings-(group|section)="([^"]+)"/g)) {
    if (match[1] === "group") groups[(current = match[2]!)] = [];
    else groups[current]!.push(match[2]!);
  }
  return groups;
}

describe("Settings rail groups", () => {
  it("files every page under You, AI, Computers or Account, in that order", () => {
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual(["you", "ai", "computers", "account"]);
    const ids = SECTIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(19); // Includes iMessage setup, the shared Skills library and trusted contacts
    for (const entry of SECTIONS) expect(SETTINGS_GROUPS.map((group) => group.id)).toContain(entry.group);
  });

  it("shows every desktop page under its labelled group", () => {
    vi.stubGlobal("window", { ogb: { environments: {}, organization: {}, cloudAccount: {} } });
    const html = render();
    for (const label of ["You", "AI", "Computers", "Account"]) expect(html).toContain(`>${label}</div>`);
    expect(html).toContain("glass-surface");
    expect(rail(html)).toEqual({
      you: ["general", "appearance", "companion"],
      ai: ["engines", "connections", "decisionModel"],
      computers: ["desktopWorkspaces", "computer"],
      account: ["cloudAccount", "organization", "usage", "backups", "experimental"],
    });
    // the narrow-window picker carries the same groups
    expect(html).toContain('<optgroup label="AI">');
  });

  it("keeps the browser-only pages for a hosted workspace's admins", () => {
    fixture.ownerOrAdmin = true;
    const groups = rail(render());
    expect(groups.account).toEqual(["usage", "backups", "inkbox", "trustedContacts", "people", "activity", "experimental"]);
    // desktop-only pages stay out of a browser
    expect(Object.values(groups).flat()).not.toContain("desktopWorkspaces");
    expect(Object.values(groups).flat()).not.toContain("cloudAccount");
  });

  it("makes iMessage setup discoverable for a local desktop owner", () => {
    fixture.ownerOrAdmin = true;
    vi.stubGlobal("window", { ogb: { environments: {} } });
    expect(rail(render()).account).toContain("inkbox");
    expect(render()).toContain("Inkbox");
  });

  it("shows a paired remote client only Appearance, Remote access and Servers", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true }, environments: {}, organization: {}, cloudAccount: {} } });
    expect(rail(render())).toEqual({ you: ["appearance", "companion"], computers: ["desktopWorkspaces"] });
  });

  it("keeps the old deep links landing on the same page", () => {
    vi.stubGlobal("window", { ogb: { environments: {} } });
    fixture.section = "remote" as AppSettingsSection;
    expect(render()).toContain('data-settings-section="companion" aria-current="page"');
    fixture.section = "connections";
    expect(render()).toContain('data-settings-section="connections" aria-current="page"');
  });
});
