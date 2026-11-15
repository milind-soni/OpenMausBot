import { beforeEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import { en } from "@/locales";
import type { AppSettingsSection } from "@/state/store";
import {
  ADVANCED_PAGES, LEGACY_SETTINGS, SETTINGS_INDEX, SETTINGS_PAGES, fullContext, needsAdvanced, resolveSettingsTarget, searchSettings, visiblePages,
  type SettingsContext,
} from "./settings-index";

beforeEach(() => setLocale("en"));

const ids = (ctx: SettingsContext) => visiblePages(ctx).map((page) => page.id);
const PLACE_PAGES = ["overview", "phone", "ai", "bots", "desktops", "vault", "usage", "transfer", "data"];
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
    // A team's member is offered none of the installation's admin pages (AI, Desktops, Spending, Import & export, Data).
    const expected = who === "a team member" ? PLACE_PAGES.filter((id) => !["ai", "desktops", "usage", "transfer", "data"].includes(id)) : PLACE_PAGES;
    expect(ids(ctx).filter((id) => PLACE_PAGES.includes(id))).toEqual(expected);
  });

  // Owner decisions (Nov 11, Nov 12): Simple shows nine entries, Import & export among them; Advanced adds You and your
  // bots, Desktops & browser, Spending, Data and General in their places.
  it.each(["local only", "This computer, with My Cloud", "My Cloud's page in the desktop window", "My Cloud in a browser (owner)"] as const)(
    "shows Simple's nine entries for %s", (who) => {
      expect(ids({ ...PEOPLE[who], advanced: false })).toEqual(["overview", "phone", "ai", "vault", "transfer", "account", "plan", "app", "appearance"]);
    });

  it("is shorter in Simple: the five Advanced pages come back in Advanced, in place", () => {
    const simple = ids(fullContext({ advanced: false }));
    for (const page of ADVANCED_PAGES) expect(simple).not.toContain(page);
    expect(ids(fullContext()).filter((id) => simple.includes(id))).toEqual(simple);
  });

  it("turns Advanced on for a link, a notice or a search hit that asks for an Advanced page or row from Simple", () => {
    const simple = fullContext({ advanced: false });
    expect(resolveSettingsTarget("general", simple)).toEqual({ page: "general", advanced: true });
    expect(resolveSettingsTarget("activity", simple)).toEqual({ page: "data", anchor: "activity", advanced: true });
    expect(resolveSettingsTarget("backups", simple)).toEqual({ page: "transfer", anchor: "take-out" });
    expect(resolveSettingsTarget("import", simple)).toEqual({ page: "transfer", anchor: "bring-in" });
    expect(resolveSettingsTarget("decisionModel", simple)).toEqual({ page: "ai", anchor: "routing", advanced: true });
    expect(resolveSettingsTarget("phone", simple)).toEqual({ page: "phone" });
    expect(needsAdvanced({ page: "general" }, fullContext())).toBe(false);
  });

  it.each(Object.keys(LEGACY_SETTINGS) as AppSettingsSection[])("lands old link %s on a real page in Simple too", (id) => {
    for (const ctx of Object.values(PEOPLE)) {
      const simple = { ...ctx, advanced: false };
      const target = resolveSettingsTarget(id, simple);
      expect(SETTINGS_PAGES.find((page) => page.id === target.page)?.when({ ...simple, advanced: Boolean(target.advanced) })).toBe(true);
    }
  });

  it("finds every Advanced-only row from Simple, marked Advanced; Simple's own homes win for moved rows", () => {
    const simple = fullContext({ advanced: false });
    for (const query of ["parallel threads", "effort", "spending", "send", "storage"]) {
      const hit = find(query, simple)[0];
      expect(hit, query).toBeDefined();
      expect(hit!.advanced, query).toBe(true);
    }
    expect(find("language", simple)[0]?.entry.page).toBe("app");
    expect(find("backups", simple)[0]).toMatchObject({ entry: { page: "transfer" }, advanced: undefined });
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
    for (const page of ["ai", "desktops", "usage", "transfer", "data"] as const) {
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
    expect(where("backups")).toEqual({ page: "transfer", anchor: "take-out" });
    expect(where("import")).toEqual({ page: "transfer", anchor: "bring-in" });
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

  describe.each([["Simple", false], ["Advanced", true]] as const)("Import & export in %s", (_mode, advanced) => {
    const owner = fullContext({ advanced });
    it.each(["grok", "grok bot", "move from"])("puts Move from Grok Bot first for “%s”, with no Advanced tag", (query) => {
      expect(find(query, owner)[0]).toMatchObject({ entry: { id: "grok-move", page: "transfer", anchor: "grok-move" }, advanced: undefined });
    });

    it.each(["import", "bring", "export", "backup", "restore"])("lands “%s” on Import & export", (query) => {
      const hit = find(query, owner)[0];
      expect(hit?.entry.page, query).toBe("transfer");
      expect(hit?.advanced, query).toBeUndefined();
    });

    it("finds each row by its natural words", () => {
      const found = (query: string) => find(query, owner).map((hit) => hit.entry.id);
      expect(found("import")).toEqual(expect.arrayContaining(["page:transfer", "grok-move", "ai-apps", "backup-import", "bring-in"]));
      expect(found("export")).toEqual(expect.arrayContaining(["page:transfer", "backup-export", "take-out"]));
      expect(found("backup")).toEqual(expect.arrayContaining(["backup-export", "backup-import"]));
      expect(first("restore", owner)?.id).toBe("backup-import");
    });

    it("offers a team's member none of it, and a team's admin all of it", () => {
      for (const query of ["grok", "import", "export", "backup", "restore", "bring"]) {
        expect(find(query, { ...PEOPLE["a team member"], advanced }).filter((hit) => hit.entry.page === "transfer"), query).toEqual([]);
        expect(find(query, { ...PEOPLE["a team admin"], advanced })[0]?.entry.page, query).toBe("transfer");
      }
    });
  });

  it("lists no import, export or backup row under Data", () => {
    const data = SETTINGS_INDEX.filter((entry) => entry.page === "data").map((entry) => entry.id);
    expect(data).toEqual(["storage", "activity"]);
  });

  it("finds Advanced rows from Simple too, so they can be used in place", () => {
    expect(find("parallel threads", fullContext({ advanced: false }))[0]?.advanced).toBe(true);
  });

  it("lists This computer's rows under On your other places on My Cloud's rail, and never with one place", () => {
    const wifi = find("wifi", PEOPLE["My Cloud's page in the desktop window"]);
    expect(wifi.find((hit) => hit.entry.id === "wifi")?.elsewhere).toBe(true);
    // My Cloud has no Same Wi-Fi of its own, so its own phone page isn't offered for it.
    expect(wifi.some((hit) => hit.entry.id === "page:phone")).toBe(false);
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
