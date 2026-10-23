import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SECTIONS, SIMPLE_HIDDEN_SECTIONS, SIMPLE_PAGES, SettingsModal, revealSettingsBlock } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
  advancedMode: false,
  config: { features: { browser: false }, browserEngine: { kind: "bundled", installable: true }, composio: { mode: "self" } } as Record<string, unknown>,
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
  ownerOrAdmin: null as boolean | null,
}));

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [], bots: [], config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advancedMode,
  setAdvancedMode: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
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
// Each page's own content has its own tests; here a marker says which ran.
const { marker } = vi.hoisted(() => ({
  marker: (name: string) => () => `MARKER:${name};`,
}));
vi.mock("./EnginesSettings", () => ({ EnginesSettings: marker("engines") }));
vi.mock("./DecisionModelSettings", () => ({ DecisionModelSettings: marker("decisionModel") }));
vi.mock("./ApiKeys", () => ({
  ApiKeyRow: marker("apiKey"),
  AnthropicEveryClaudeBot: marker("anthropicEvery"),
  OpenAiCompatUrl: marker("compatUrl"),
  OpenCodeProviderKeys: marker("opencodeProviderKeys"),
  VpsConnection: marker("vps"),
}));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: marker("companion") }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./CompanionSection", () => ({ CompanionSection: () => null }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: () => null }));
vi.mock("./ConnectedWorkspacesSettings", () => ({ ConnectedWorkspacesSettings: marker("desktopWorkspaces") }));
vi.mock("./LocalComputerSection", () => ({ LocalComputerSection: marker("computer") }));
vi.mock("./CloudAccountSettings", () => ({ CloudAccountSettings: marker("cloudAccount") }));
vi.mock("./OrganizationSettings", () => ({ OrganizationSettings: marker("organization") }));
vi.mock("./PeopleSection", () => ({ PeopleSection: marker("people") }));
vi.mock("./ActivitySection", () => ({ ActivitySection: marker("activity") }));
vi.mock("./UsageSection", () => ({ UsageSection: marker("usage") }));
vi.mock("./WorkspaceBackupSettings", () => ({ WorkspaceBackupSettings: marker("backups") }));
vi.mock("./RoomTurnTimeoutSettings", () => ({ RoomTurnTimeoutSettings: () => null }));
vi.mock("./CompanyBackupSettings", () => ({ CompanyBackupSettings: () => null }));
vi.mock("./ImportSettings", () => ({ ImportSettings: marker("import") }));

const desktop = { ogb: { environments: {}, organization: {}, cloudAccount: {} } };

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "general";
  fixture.advancedMode = false;
  fixture.config = { features: { browser: false }, browserEngine: { kind: "bundled", installable: true }, composio: { mode: "self" } };
  fixture.switches = [];
  fixture.ownerOrAdmin = null;
  fixture.api.mockResolvedValue({});
  vi.stubGlobal("window", desktop);
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));
const pages = (html: string) => [...html.matchAll(/data-settings-page="([^"]+)"/g)].map((match) => match[1]);
const currentPage = (html: string) => html.match(/data-settings-page="([^"]+)" aria-current="page"/)?.[1];
const blocks = (html: string) => [...html.matchAll(/data-settings-block="([^"]+)"/g)].map((match) => match[1]);
const markers = (html: string) => [...html.matchAll(/MARKER:([^;]+);/g)].map((match) => match[1]);

describe("Settings in Simple mode", () => {
  it("draws at most six pages on the desktop, MausBot Cloud among them, and none of the Advanced-only ones", () => {
    const html = render();
    expect(pages(html)).toEqual(["general", "appearance", "ai", "computers", "cloud", "account"]);
    expect(SIMPLE_PAGES.length).toBeLessThanOrEqual(6);
    expect(html).not.toContain("data-settings-group=");
    expect(html).not.toContain("data-settings-section=");
    for (const hidden of ["backups", "experimental", "workspaces", "skills"]) expect(html).not.toContain(`value="${hidden}"`);
    const picker = html.match(/<select aria-label="Settings"[\s\S]*?<\/select>/)![0];
    expect([...picker.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])).toEqual(["general", "appearance", "ai", "computers", "cloud", "account"]);
  });

  it("files every Advanced page under one Simple page, or hides it", () => {
    const placed = SIMPLE_PAGES.flatMap((page) => page.sections);
    expect(new Set(placed).size).toBe(placed.length);
    const hidden = SECTIONS.map((entry) => entry.id).filter((id) => !placed.includes(id));
    expect(hidden).toEqual(["skills", "backups", "workspaces", "experimental"]);
    for (const id of hidden) expect(SIMPLE_HIDDEN_SECTIONS).toContain(id);
  });

  it("keeps General as it is, Advanced mode switch first", () => {
    const html = render();
    expect(currentPage(html)).toBe("general");
    expect(html.indexOf('aria-label="Advanced mode"')).toBeGreaterThan(0);
    expect(html.indexOf('aria-label="Advanced mode"')).toBeLessThan(html.indexOf("Language"));
    expect(blocks(html)).toEqual(["general"]);
  });

  it("stacks Model providers, API keys and Decision model on AI, each under its heading", () => {
    fixture.section = "engines";
    const html = render();
    expect(currentPage(html)).toBe("ai");
    expect(blocks(html)).toEqual(["engines", "connections", "decisionModel"]);
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
    expect(headings).toEqual(["Model providers", "API keys", "Decision model"]);
    expect(markers(html).filter((name) => name === "engines" || name === "decisionModel")).toEqual(["engines", "decisionModel"]);
    expect(html).toContain("More providers for OpenCode bots");
  });

  it("stacks Remote access, Servers, Bot desktops, the built-in browser and Logins on Devices", () => {
    fixture.section = "companion";
    const html = render();
    expect(currentPage(html)).toBe("computers");
    expect(blocks(html)).toEqual(["companion", "desktopWorkspaces", "computer", "browser", "logins"]);
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
    expect(headings).toEqual(["Remote access", "Servers", "Bot desktops", "Built-in browser", "Logins"]);
    expect(html).toContain('aria-label="Enable the built-in browser"');
  });

  it("gives MausBot Cloud its own page, and stacks Organization, Import and Usage on Account in the desktop app", () => {
    fixture.section = "cloudAccount";
    let html = render();
    expect(currentPage(html)).toBe("cloud");
    expect(blocks(html)).toEqual(["cloudAccount"]);
    fixture.section = "organization";
    html = render();
    expect(currentPage(html)).toBe("account");
    expect(blocks(html)).toEqual(["organization", "import", "usage"]);
    expect(markers(html)).toContain("import");
  });

  it("adds People and Activity to Account, above Usage, for a hosted workspace's admins in a browser", () => {
    vi.stubGlobal("window", {});
    fixture.ownerOrAdmin = true;
    fixture.section = "people";
    const html = render();
    expect(pages(html)).toEqual(["general", "appearance", "ai", "computers", "account"]);
    expect(blocks(html)).toEqual(["people", "activity", "usage"]);
  });

  it("keeps Account for Usage alone when nothing else on it is shown", () => {
    vi.stubGlobal("window", {});
    fixture.config = { ...fixture.config, cloudHome: true };
    fixture.section = "usage";
    const html = render();
    expect(pages(html)).toEqual(["general", "appearance", "ai", "computers", "account"]);
    expect(blocks(html)).toEqual(["usage"]);
  });

  it("keeps a paired remote client's reduced set: Appearance, and Devices with Remote access and Servers", () => {
    vi.stubGlobal("window", { ogb: { ...desktop.ogb, remoteClient: { active: true } } });
    fixture.section = "desktopWorkspaces";
    const html = render();
    expect(pages(html)).toEqual(["appearance", "computers"]);
    expect(currentPage(html)).toBe("computers");
    expect(blocks(html)).toEqual(["companion", "desktopWorkspaces"]);
    expect(html).not.toContain('aria-label="Enable the built-in browser"');
  });

  it.each<[AppSettingsSection, string]>([
    ["general", "general"],
    ["appearance", "appearance"],
    ["engines", "ai"],
    ["connections", "ai"],
    ["decisionModel", "ai"],
    ["companion", "computers"],
    ["remote", "computers"],
    ["desktopWorkspaces", "computers"],
    ["computer", "computers"],
    ["cloudAccount", "cloud"],
    ["organization", "account"],
    ["import", "account"],
  ])("lands a deep link to %s on %s", (section, page) => {
    fixture.section = section;
    const html = render();
    expect(currentPage(html)).toBe(page);
    expect(blocks(html)).toContain(section === "remote" ? "companion" : section);
  });

  it.each<[AppSettingsSection, string]>([
    ["backups", "backups"],
    ["experimental", "skillAuthoring"],
  ])("opens a hidden page (%s) for as long as it is the open one", (section, content) => {
    fixture.section = section;
    const html = render();
    expect(pages(html)).toEqual(["general", "appearance", "ai", "computers", "cloud", "account", section]);
    expect(currentPage(html)).toBe(section);
    if (content === "skillAuthoring") expect(html).toContain("Bots may write their own skills");
    else expect(markers(html)).toContain(content);
  });

  it("scrolls a later section of a stacked page into view, and starts a page at its top", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn(() => ({ scrollIntoView }));
    const scroller = { scrollTop: 320, querySelector };
    revealSettingsBlock(scroller, "connections", 1);
    expect(querySelector).toHaveBeenCalledWith('[data-settings-block="connections"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    revealSettingsBlock(scroller, "engines", 0);
    expect(scroller.scrollTop).toBe(0);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe("the built-in browser switch", () => {
  const browserSwitch = () => fixture.switches.find((props) => props["aria-label"] === "Enable the built-in browser");

  it.each([false, true])("writes features.browser from Devices (advanced: %s)", async (advanced) => {
    fixture.advancedMode = advanced;
    fixture.section = "computer";
    const html = render();
    if (advanced) {
      expect(html.indexOf('aria-label="Enable the built-in browser"')).toBeLessThan(html.indexOf("MARKER:computer;"));
    } else {
      expect(html.indexOf("MARKER:computer;")).toBeLessThan(html.indexOf('aria-label="Enable the built-in browser"'));
    }
    const toggle = browserSwitch()!;
    expect(toggle.checked).toBe(false);
    toggle.onClick!({} as never);
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: {} }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
  });

  it("is no longer on Experimental, which keeps skill drafting", () => {
    fixture.advancedMode = true;
    fixture.section = "experimental";
    const html = render();
    expect(html).not.toContain('aria-label="Enable the built-in browser"');
    expect(html).toContain("Bots may write their own skills");
    expect(browserSwitch()).toBeUndefined();
  });

  it("is found by searching for the browser under Bot desktops in Advanced", () => {
    const computer = SECTIONS.find((entry) => entry.id === "computer")!;
    const experimental = SECTIONS.find((entry) => entry.id === "experimental")!;
    expect(computer.keywords).toContain("browser");
    expect(experimental.keywords).not.toContain("browser");
  });
});


it.each([
  [false, "engines", true], [false, "connections", true], [false, "decisionModel", true],
  [true, "engines", true], [true, "connections", false], [true, "decisionModel", false],
] as const)("keeps the providers surface opaque exactly when visible (advanced=%s, section=%s)", (advanced, section, providersVisible) => {
  fixture.advancedMode = advanced;
  fixture.section = section;
  const html = render();
  expect(html.includes("MARKER:engines;")).toBe(providersVisible);
  expect(html.includes("glass-surface-opaque")).toBe(providersVisible);
});
