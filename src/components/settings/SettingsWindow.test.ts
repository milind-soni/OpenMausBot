import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "../SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  section: "overview" as AppSettingsSection,
  advanced: false,
  admin: true as boolean | null,
  config: {} as Record<string, unknown>,
  setAdvancedMode: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as Array<{ "aria-labelledby"?: string; checked: boolean; onClick?: (event: never) => void }>,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({ state: { appSettingsSection: fixture.section, appSettingsPhonePairing: 0, appSettingsCloudLink: 0, instances: [], bots: [], config: fixture.config, activeView: "chat" }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: fixture.setAdvancedMode }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn(), track: vi.fn() }));
vi.mock("../DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" } } }), windowFramed: () => false }));
vi.mock("../SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("../SettingsPrimitives")>();
  return { ...original, Switch: (props: ComponentProps<typeof Switch>) => { fixture.switches.push(props as never); return createElement(original.Switch, props); } };
});

import { SettingsModal } from "../SettingsModal";
import { profileMenuItems } from "../SidebarProfileMenu";

const COMPANION = { state: () => new Promise(() => {}) };
const desktopHere = (extra: Record<string, unknown> = {}) => ({ ogb: { platform: "darwin", companion: COMPANION, environments: { state: () => new Promise(() => {}) }, ...extra } });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "overview";
  fixture.advanced = false;
  fixture.admin = true;
  fixture.config = {};
  fixture.switches = [];
  vi.stubGlobal("window", desktopHere());
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  vi.stubGlobal("location", { host: "studio.example.com" });
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

const render = (section: AppSettingsSection = fixture.section) => { fixture.section = section; return renderToStaticMarkup(createElement(SettingsModal)); };
const navPages = (html: string) => [...html.matchAll(/data-settings-page="([a-z]+)"/g)].map((match) => match[1]);

describe("the Settings window", () => {
  it("opens with the place, Your account and This app, each headed by an identity row", () => {
    const html = render();
    expect(navPages(html)).toEqual(["overview", "phone", "ai", "bots", "desktops", "vault", "usage", "data", "account", "app", "general", "appearance"]);
    expect(html).toContain("This computer");
    expect(html).toContain("Your account");
    expect(html).toContain("This app");
    expect(html).toContain('aria-current="page"');
  });

  it("titles Overview with the place's name and its status line, never For …", () => {
    const html = render("overview");
    expect(html).toMatch(/<h2[^>]*>This computer<\/h2>/);
    expect(html).toContain("Updates with the app");
    expect(html).not.toMatch(/data-settings-scope[^>]*>[^<]*For /);
  });

  it("says which place a place page changes, and that account and app pages stay the same, without “place” for a person with one place", () => {
    expect(render("phone")).toContain("This computer");
    const account = render("account");
    expect(account).toContain("Your MausBot account");
    expect(account).not.toContain("Same on every place");
    expect(render("general")).toContain("MausBot on this device");
  });

  it("is one tree in Simple and Advanced; Advanced only adds rows", () => {
    fixture.advanced = false;
    const simple = render("appearance");
    fixture.advanced = true;
    const advanced = render("appearance");
    expect(navPages(simple)).toEqual(navPages(advanced));
    expect(simple).not.toContain("Chat width");
    expect(advanced).toContain("Chat width");
    expect(simple).toContain("Light or dark");
    expect(simple).toContain("Browse themes");
  });

  it("keeps the Advanced mode switch in the nav footer on every page, and flips it from there", () => {
    for (const page of ["overview", "phone", "general"] as const) expect(render(page)).toContain('id="settings-advanced-mode"');
    const toggle = fixture.switches.find((props) => props["aria-labelledby"] === "settings-advanced-mode")!;
    toggle.onClick!({} as never);
    expect(fixture.setAdvancedMode).toHaveBeenCalledWith(true);
  });

  it("shows This computer's phone page with its pairing loading under the same title", () => {
    vi.stubGlobal("ogb", desktopHere().ogb);
    const html = render("phone");
    expect(html).toContain('data-phone-pairing="computer"');
    expect(html).toMatch(/<h2[^>]*>Phone &amp; devices<\/h2>/);
  });

  it("on My Cloud's page in the window: Phone & devices keeps its name and pairs with the Cloud, and This app rows it can't reach say so", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin", workspaces: { state: () => new Promise(() => {}), places: () => new Promise(() => {}) } } });
    fixture.config = { cloudHome: true };
    const phone = render("phone");
    expect(phone).toMatch(/<h2[^>]*>Phone &amp; devices<\/h2>/);
    expect(phone).not.toContain("This server");
    expect(phone).toContain("My Cloud");
    expect(render("overview")).toContain("Always on");
    const app = render("general");
    expect(app).toContain("Open at login");
    expect(app).toContain('data-settings-inert=""');
  });

  it("in a browser: This browser, saved in this browser, with no startup or window rows", () => {
    vi.stubGlobal("window", {});
    fixture.config = { cloudHome: true };
    const general = render("general");
    expect(general).toContain("This browser");
    expect(general).toContain("Saved in this browser");
    expect(general).not.toContain("Open at login");
    expect(render("appearance")).not.toContain("Window frame");
  });

  it("offers a team's member no AI page (an old link lands on Overview and says so), and shows People to admins only", () => {
    vi.stubGlobal("window", {});
    fixture.config = { cloudHome: true, team: { name: "Acme" } };
    fixture.admin = false;
    expect(render("ai")).toContain("AI isn&#x27;t on Acme.");
    expect(navPages(render("overview"))).not.toContain("ai");
    expect(navPages(render("overview"))).not.toContain("people");
    fixture.admin = true;
    expect(navPages(render("overview"))).toContain("people");
  });

  it("opens an old page's link on its new page", () => {
    expect(render("decisionModel")).toMatch(/data-settings-page-open="ai"/);
    expect(render("companion")).toMatch(/data-settings-page-open="phone"/);
    expect(render("logins")).toMatch(/data-settings-page-open="vault"/);
  });

  it("uses one switch and one button family: the window draws every row in the Settings look", () => {
    expect(render("general")).toContain('data-settings-look="simple"');
  });
});

describe("the outer menu", () => {
  const items = (simple: boolean) => profileMenuItems({
    phone: { key: "phone-devices", label: "Phone & devices", onSelect: () => {} },
    update: null,
    header: { name: "Ada Lovelace", line: "Not signed in", avatar: null, onOpen: () => {} },
    plan: { key: "plan", label: "Plan & billing", onSelect: () => {} },
    ...(simple ? { simple: { tools: [{ key: "automations", label: "Automations", onSelect: () => {} }] } } : {}),
    onSettings: () => {}, onShortcuts: () => {}, onAbout: () => {}, onHelp: () => {}, onFeedback: () => {},
  }).map((item) => item.key);

  it("puts your account first, then Phone & devices and Settings, in both modes", () => {
    expect(items(false)).toEqual(["account", "phone-devices", "settings", "plan", "support"]);
    expect(items(true)).toEqual(["account", "phone-devices", "settings", "automations", "plan", "support"]);
  });
});
