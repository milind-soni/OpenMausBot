import { beforeEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import { en } from "@/locales";
import type { AppSettingsSection } from "@/state/store";
import {
  LEGACY_SETTINGS, SETTINGS_INDEX, SETTINGS_PAGES, fullContext, resolveSettingsTarget, searchSettings, visiblePages,
  type SettingsContext,
} from "./settings-index";

beforeEach(() => setLocale("en"));

const ids = (ctx: SettingsContext) => visiblePages(ctx).map((page) => page.id);
const PLACE_PAGES = ["overview", "phone", "ai", "bots", "desktops", "vault", "usage", "data"];
const find = (query: string, ctx: SettingsContext = fullContext()) => searchSettings(query, ctx, (entry) => t(entry.labelKey), (page) => t(page.labelKey));
const first = (query: string, ctx?: SettingsContext) => find(query, ctx)[0]?.entry;

const PEOPLE = {
  "local only": fullContext(),
  "This computer, with My Cloud": fullContext({ places: true }),
  "My Cloud's page in the desktop window": fullContext({ here: false, cloud: true, places: true }),
  "My Cloud in a browser (owner)": fullContext({ desktop: false, here: false, cloud: true, environments: false }),
  "a team member": fullContext({ desktop: false, here: false, cloud: true, team: true, admin: false, plan: false, environments: false }),
  "a team admin": fullContext({ desktop: false, here: false, cloud: true, team: true, admin: true, plan: false, environments: false }),
};

describe("the pages", () => {
  it("lists the place's pages, then Your account, then This app, in one fixed order", () => {
    expect(ids(fullContext())).toEqual([...PLACE_PAGES, "account", "plan", "app", "general", "appearance"]);
  });

  it.each(Object.entries(PEOPLE))("keeps the same place pages, in the same order, for %s", (who, ctx) => {
    // A team's member is offered none of the installation's admin pages (AI, Desktops, Spending, Data).
    const expected = who === "a team member" ? PLACE_PAGES.filter((id) => !["ai", "desktops", "usage", "data"].includes(id)) : PLACE_PAGES;
    expect(ids(ctx).filter((id) => PLACE_PAGES.includes(id))).toEqual(expected);
  });

  it("is the same in Simple and Advanced: Advanced only adds rows", () => {
    expect(ids(fullContext({ advanced: true }))).toEqual(ids(fullContext({ advanced: false })));
  });

  it("names Phone & devices the same on every place: there is no This server page", () => {
    for (const ctx of Object.values(PEOPLE)) expect(visiblePages(ctx).find((page) => page.id === "phone")?.labelKey).toBe("settings.section.phoneDevices");
    expect(JSON.stringify(SETTINGS_PAGES)).not.toContain("thisServer");
  });

  it("shows People to admins of a team or a self-hosted server only, and Plan & billing where the plan can be read", () => {
    expect(ids(PEOPLE["a team admin"])).toContain("people");
    expect(ids(PEOPLE["a team member"])).not.toContain("people");
    expect(ids(fullContext({ desktop: false, here: false, admin: true }))).toContain("people");
    expect(ids(PEOPLE["My Cloud's page in the desktop window"])).not.toContain("people");
    expect(ids(PEOPLE["a team member"])).not.toContain("plan");
    expect(ids(fullContext({ plan: false }))).not.toContain("plan");
  });

  it("offers a team's member none of the installation's admin pages, and a team's admin all of them", () => {
    for (const page of ["ai", "desktops", "usage", "data"] as const) {
      expect(ids(PEOPLE["a team member"])).not.toContain(page);
      expect(ids(PEOPLE["a team admin"])).toContain(page);
    }
  });

  it("drops the place's pages and Plan & billing for a paired client, which keeps This app", () => {
    expect(ids(fullContext({ client: true }))).toEqual(["overview", "account", "app", "general", "appearance"]);
  });
});

describe("old links", () => {
  const legacy = Object.keys(LEGACY_SETTINGS) as AppSettingsSection[];
  it.each(legacy)("sends %s to a page that exists, for every person", (id) => {
    for (const ctx of Object.values(PEOPLE)) {
      const target = resolveSettingsTarget(id, ctx);
      expect(SETTINGS_PAGES.find((page) => page.id === target.page)?.when(ctx)).toBe(true);
    }
  });

  it("lands each old page where the design says", () => {
    const ctx = fullContext();
    const where = (id: AppSettingsSection) => resolveSettingsTarget(id, ctx);
    expect(where("companion")).toEqual({ page: "phone" });
    expect(where("remote")).toEqual({ page: "phone" });
    expect(resolveSettingsTarget("remote", fullContext({ client: true }))).toEqual({ page: "app", anchor: "your-computers" });
    expect(where("engines")).toEqual({ page: "ai", anchor: "providers" });
    expect(where("connections")).toEqual({ page: "ai", anchor: "ai-keys" });
    expect(where("imageGeneration")).toEqual({ page: "ai", anchor: "images" });
    expect(where("computer")).toEqual({ page: "desktops" });
    expect(where("logins")).toEqual({ page: "vault" });
    expect(where("cloudAccount")).toEqual({ page: "plan", anchor: "plan" });
    expect(resolveSettingsTarget("cloudAccount", fullContext({ plan: false }))).toEqual({ page: "account" });
    expect(where("organization")).toEqual({ page: "account", anchor: "organization" });
    expect(where("desktopWorkspaces")).toEqual({ page: "app", anchor: "your-computers" });
    expect(where("backups")).toEqual({ page: "data", anchor: "backups" });
    expect(where("import")).toEqual({ page: "data", anchor: "bring-in" });
    expect(where("activity")).toEqual({ page: "data", anchor: "activity" });
    expect(where("experimental")).toEqual({ page: "bots", anchor: "early" });
    expect(where("skills")).toEqual({ page: "bots", anchor: "skills" });
    expect(where("updates")).toEqual({ page: "app", anchor: "updates" });
    expect(resolveSettingsTarget("updates", PEOPLE["My Cloud in a browser (owner)"])).toEqual({ page: "overview" });
    expect(where("usage")).toEqual({ page: "usage" });
  });

  it("opens Overview, saying so, when the page can't exist on this place", () => {
    expect(resolveSettingsTarget("botAccess", PEOPLE["a team member"])).toEqual({ page: "overview", missing: "people" });
  });
});

describe("search", () => {
  it.each(["phone", "pair", "qr", "iphone", "android", "this server", "pair a device", "connect your phone"])("puts Phone & devices first for “%s”", (query) => {
    expect(first(query)?.page).toBe("phone");
  });

  it.each(["name", "my name", "photo", "avatar", "profile", "profile picture"])("puts About you first for “%s”", (query) => {
    expect(first(query)?.anchor).toBe("about-you");
  });

  it.each(["spending", "cost", "tokens"])("puts Spending first for “%s”", (query) => expect(first(query)?.page).toBe("usage"));
  it.each(["notifications", "sounds"])("puts General › Notifications first for “%s”", (query) => expect(first(query)?.anchor).toBe("notifications"));
  it.each(["password", "login"])("puts Vault first for “%s”", (query) => expect(first(query)?.page).toBe("vault"));
  it.each(["dark mode", "night mode"])("puts Light or dark first for “%s”", (query) => expect(first(query)?.id).toBe("light-dark"));
  it.each(["sign in", "log in", "log out"])("puts Your account first for “%s”", (query) => expect(first(query)?.page).toBe("account"));
  it.each(["wallpaper", "background"])("puts Sidebar picture first for “%s”", (query) => expect(first(query)?.id).toBe("sidebar-picture"));
  it.each(["cancel", "billing", "invoice", "subscription", "refund"])("puts Plan & billing first for “%s”", (query) => expect(first(query)?.page).toBe("plan"));
  it.each(["voice", "microphone", "dictation"])("puts the Talk shortcut first for “%s” on the desktop", (query) => expect(first(query)?.id).toBe("talk"));
  it("puts All bots on You and your bots", () => expect(first("all bots")?.page).toBe("bots"));
  it("finds Activity in Data where it exists: a browser, for an admin", () => {
    expect(first("activity", PEOPLE["a team admin"])?.anchor).toBe("activity");
    expect(find("activity", fullContext()).some((hit) => hit.entry.anchor === "activity")).toBe(false);
  });

  it("finds Advanced rows from Simple too, so they can be used in place", () => {
    expect(first("parallel threads", fullContext({ advanced: false }))?.advanced).toBe(true);
  });

  it("lists This computer's rows under On your other places on My Cloud's rail, and never with one place", () => {
    const wifi = find("wifi", PEOPLE["My Cloud's page in the desktop window"]);
    expect(wifi.find((hit) => hit.entry.id === "wifi")?.elsewhere).toBe(true);
    expect(find("wifi", PEOPLE["My Cloud in a browser (owner)"]).some((hit) => hit.entry.id === "wifi")).toBe(false);
  });

  it("finds nothing for nonsense, and never a row whose page can't show here", () => {
    expect(find("zzqx")).toEqual([]);
    for (const hit of find("people", PEOPLE["a team member"])) expect(hit.entry.page).not.toBe("people");
  });

  it("has a label in English for every row, and every row's page is a real page", () => {
    for (const entry of SETTINGS_INDEX) {
      expect(en[entry.labelKey], entry.id).toBeTruthy();
      expect(SETTINGS_PAGES.some((page) => page.id === entry.page), entry.id).toBe(true);
    }
  });
});
