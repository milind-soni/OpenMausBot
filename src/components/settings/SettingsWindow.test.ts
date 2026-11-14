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
    fixture.advanced = true;
    const html = render();
    expect(navPages(html)).toEqual(["overview", "phone", "ai", "bots", "desktops", "vault", "usage", "transfer", "data", "account", "app", "general", "appearance"]);
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
    expect(render("appearance")).toContain("MausBot on this device");
  });

  // Owner decisions (Nov 11, Nov 12): Simple's nav is shorter. Nine entries, the same for every person and every rail.
  const SIMPLE_NAV = ["overview", "phone", "ai", "vault", "transfer", "account", "plan", "app", "appearance"];
  const SIMPLE_PEOPLE: Array<[string, () => void]> = [
    ["a person with only this computer", () => vi.stubGlobal("window", desktopHere({ cloudAccount: { state: () => new Promise(() => {}), onState: () => () => {} } }))],
    ["This computer's rail, with My Cloud", () => vi.stubGlobal("window", desktopHere({ cloudAccount: { state: () => new Promise(() => {}), onState: () => () => {} }, workspaces: { state: () => new Promise(() => {}), places: () => new Promise(() => {}) } }))],
    ["My Cloud's rail in the desktop window", () => { vi.stubGlobal("window", { ogb: { platform: "darwin", cloudPlan: { state: () => new Promise(() => {}) }, workspaces: { state: () => new Promise(() => {}), places: () => new Promise(() => {}) } } }); fixture.config = { cloudHome: true }; }],
    ["My Cloud in a browser", () => { vi.stubGlobal("window", {}); fixture.config = { cloudHome: true }; }],
  ];
  it.each(SIMPLE_PEOPLE)("shows Simple's nine entries for %s", (_who, set) => {
    set();
    fixture.advanced = false;
    expect(navPages(render("overview"))).toEqual(SIMPLE_NAV);
    fixture.advanced = true;
    const advanced = navPages(render("overview"));
    for (const page of ["bots", "desktops", "usage", "data", "general"]) expect(advanced).toContain(page);
  });

  it("keeps the rows a Simple person needs: language and notifications on This app", () => {
    fixture.advanced = false;
    const app = render("app");
    expect(app).toContain('data-settings-block="typing"');
    expect(app).toContain("Updates, language, notifications and help.");
    fixture.advanced = true;
    expect(render("app")).not.toContain('data-settings-block="typing"');
  });

  it("turns Advanced on for a link to a page Simple doesn't show, and lands there", () => {
    fixture.advanced = false;
    expect(render("general")).toMatch(/data-settings-page-open="general"/);
    expect(render("activity")).toMatch(/data-settings-page-open="data"/);
  });

  const order = (html: string, marks: string[]) => marks.map((mark) => html.indexOf(mark));
  const ascending = (places: number[]) => places.every((at, index) => at >= 0 && (index === 0 || at > places[index - 1]!));
  describe.each([["Simple", false], ["Advanced", true]] as const)("Import & export in %s", (_mode, advanced) => {
    beforeEach(() => { fixture.advanced = advanced; });

    it("is in the menu and holds Bring things in, then Take things out, in the owner's order", () => {
      const html = render("transfer");
      expect(html).toMatch(/data-settings-page="transfer"[^>]*>[\s\S]*?Import &amp; export/);
      expect(html).toMatch(/<h2[^>]*>Import &amp; export<\/h2>/);
      expect(ascending(order(html, ['data-settings-block="bring-in"', 'data-import-section="grok"', "Move from Grok Bot", 'data-import-section="apps"',
        "From your AI apps", "Import backup", 'data-settings-block="take-out"', "Export full backup"]))).toBe(true);
      expect(html).not.toContain("Bring in a bot from another app");
    });

    it("draws the Grok Bot mark in the row's leading slot, and opens nothing until Start is pressed", () => {
      const html = render("transfer");
      const row = html.slice(html.indexOf('data-import-section="grok"'), html.indexOf('data-import-section="apps"'));
      expect(row).toMatch(/data-settings-slot=""[^>]*>\s*<span aria-hidden="true"[^>]*>\s*<svg[^>]*viewBox="0 0 70 70"/);
      expect(row).toContain("fill-[var(--color-ink)]");
      expect(row).toMatch(/data-grok-move-open[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-grok-move-open/);
      expect(row).not.toContain("data-grok-move=");
    });

    it("renders the Hermes import row at its search anchor", () => {
      expect(render("transfer")).toMatch(/data-import-section="hermes" data-settings-block="hermes-move"[\s\S]*?Move from Hermes/);
    });

    it("opens from the helper's link and an old backups link", () => {
      expect(render("import")).toMatch(/data-settings-page-open="transfer"/);
      expect(render("backups")).toMatch(/data-settings-page-open="transfer"/);
    });

    it("shows on My Cloud in a browser, to a team's admin, and not at all to a team's member", () => {
      vi.stubGlobal("window", {});
      fixture.config = { cloudHome: true };
      expect(render("transfer")).toContain("Move from Grok Bot");
      fixture.config = { cloudHome: true, team: { name: "Acme" } };
      expect(navPages(render("overview"))).toContain("transfer");
      expect(render("transfer")).toContain("Move from Grok Bot");
      fixture.admin = false;
      expect(navPages(render("overview"))).not.toContain("transfer");
      const member = render("import");
      expect(member).toMatch(/data-settings-page-open="overview"/);
      expect(member).not.toContain("Move from Grok Bot");
      expect(member).not.toContain("data-backup-export");
    });

    it("leaves no import, export or backup row on Overview or Data", () => {
      for (const page of ["overview", "data"] as const) {
        const html = render(page);
        for (const gone of ["data-backup-export", "data-backup-import", "data-import-section", "Your data"]) expect(html, `${page}: ${gone}`).not.toContain(gone);
      }
    });
  });

  it("adds rows in Advanced on the pages both modes show", () => {
    fixture.advanced = false;
    const simple = render("appearance");
    fixture.advanced = true;
    const advanced = render("appearance");
    expect(simple).not.toContain("Chat width");
    expect(advanced).toContain("Chat width");
    expect(simple).toContain("Light or dark");
    expect(simple).toContain("Browse themes");
  });

  it("keeps the Advanced mode switch in the nav footer on every page, and flips it from there", () => {
    for (const page of ["overview", "phone", "appearance"] as const) expect(render(page)).toContain('id="settings-advanced-mode"');
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
    fixture.advanced = true;
    const app = render("general");
    expect(app).toContain("Open at login");
    expect(app).toContain('data-settings-inert=""');
  });

  it("decides This app's rows and the account's place from one home: a Cloud page that is the app's home has them live", () => {
    fixture.advanced = true;
    fixture.config = { cloudHome: true };
    const cloudPage = (home: boolean) => vi.stubGlobal("window", { ogb: { platform: "darwin", workspaces: { state: () => new Promise(() => {}), places: () => new Promise(() => {}) },
      rail: { openComputer: () => Promise.resolve() },
      ...(home ? { home: {}, openAtLogin: { state: () => new Promise(() => {}), set: () => new Promise(() => {}) }, exportDiagnostics: () => Promise.resolve() } : {}) } });
    cloudPage(false);
    expect(render("general")).toContain('data-settings-inert=""');
    expect(render("app")).toMatch(/Logs and diagnostics[\s\S]*data-settings-reason/);
    cloudPage(true);
    expect(render("general")).not.toContain('data-settings-inert=""');
    expect(render("account")).not.toContain("On This computer");
  });

  it("in a browser: This browser, saved in this browser, with no startup or window rows", () => {
    vi.stubGlobal("window", {});
    fixture.advanced = true;
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
    expect(render("appearance")).toContain('data-settings-look="simple"');
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

  it("keeps Plan & billing in Settings' group in Advanced, with no divider between them", () => {
    const rows = profileMenuItems({
      phone: { key: "phone-devices", label: "Phone & devices", onSelect: () => {} }, update: null,
      header: { name: "Ada Lovelace", line: "Not signed in", avatar: null, onOpen: () => {} },
      plan: { key: "plan", label: "Plan & billing", onSelect: () => {} },
      onSettings: () => {}, onShortcuts: () => {}, onAbout: () => {}, onHelp: () => {}, onFeedback: () => {},
    });
    expect(rows.find((item) => item.key === "plan")?.separatorBefore).toBeFalsy();
    expect(rows.find((item) => item.key === "support")?.separatorBefore).toBe(true);
  });
});
