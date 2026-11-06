import { afterEach, describe, expect, it } from "vitest";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserMatesOf, loginHeldBackFor } from "../shared/logins.ts";
import { BotLogins, cardLoginPlace, cardSignInElsewhere, observeSignInPage } from "./bot-logins.ts";
import { LoginStore } from "./login-store.ts";
import type { OnePasswordLogins } from "./onepassword.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

describe("a login saved from a sign-in card", () => {
  it("fills on the card's site, at the sign-in page open on that site", () => {
    expect(cardLoginPlace("example.com", { host: "accounts.example.com", signIn: true }, undefined))
      .toEqual({ site: "example.com", hosts: ["accounts.example.com"], exactHost: false });
    expect(cardLoginPlace("example.com", { host: "www.example.com", signIn: false }, undefined))
      .toEqual({ site: "example.com", hosts: ["example.com"], exactHost: false });
    expect(cardLoginPlace("example.com", null, undefined)).toEqual({ site: "example.com", hosts: ["example.com"], exactHost: false });
  });

  it("adds a sign-in page on another site only when the person confirmed that host", () => {
    const microsoft = { host: "login.microsoftonline.com", signIn: true };
    expect(cardSignInElsewhere("example.com", microsoft)).toBe("login.microsoftonline.com");
    expect(cardLoginPlace("example.com", microsoft, "login.microsoftonline.com"))
      .toEqual({ site: "example.com", hosts: ["example.com", "login.microsoftonline.com"], exactHost: false });
    expect(cardLoginPlace("example.com", microsoft, undefined).hosts).toEqual(["example.com"]);
    expect(cardLoginPlace("example.com", microsoft, "evil.test").hosts).toEqual(["example.com"]);
    expect(cardSignInElsewhere("example.com", { host: "evil.test", signIn: false })).toBeNull();
    expect(cardLoginPlace("example.com", { host: "evil.test", signIn: false }, "evil.test").hosts).toEqual(["example.com"]);
  });
});

describe("the bot's open page", () => {
  it("is read as its host and whether it shows a password, username or email box, only for a page a login could be filled on", async () => {
    page = new FakeLoginPage("https://login.microsoftonline.com/common/oauth2/authorize?client_id=x", LOGIN_FORM);
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "login.microsoftonline.com", signIn: true });
    page.navigate("https://login.example.net/u/login/identifier", `<form><input name="username" autocomplete="username"><button>Continue</button></form>`);
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "login.example.net", signIn: true });
    page.navigate("https://example.com/dashboard", "<h1>Hello</h1>");
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "example.com", signIn: false });
    page.navigate("http://example.com/login", LOGIN_FORM);
    expect(await observeSignInPage((args) => page!.engine(args))).toBeNull();
    expect(await observeSignInPage(async () => null)).toBeNull();
    expect(await observeSignInPage(async () => { throw new Error("The browser did not answer."); })).toBeNull();
  });
});

describe("a login kept to some bots, and bots that share a browser", () => {
  // Payroll and Infra share the "finance" browser profile; Notes and Audit have their own; each guest bot gets its own
  // temporary browser.
  const bots = [
    { id: "payroll", browserProfile: "finance" }, { id: "infra", browserProfile: "finance" }, { id: "notes" }, { id: "audit", browserProfile: null },
    { id: "scout", browserProfile: "guest" }, { id: "visitor", browserProfile: "guest" },
  ];
  const onePassword = { fresh: async () => {}, sitesFor: () => [], candidates: () => [], markUsed: () => {} } as unknown as OnePasswordLogins;
  const world = () => {
    const store = new LoginStore({ dataDir: mkdtempSync(join(tmpdir(), "omb-bot-logins-")) });
    const logins = new BotLogins(store, onePassword, () => bots);
    const place = { site: "capacity.example", hosts: ["capacity.example"], exactHost: false };
    return { store, logins, place };
  };

  it("finds the bots on the same named profile, and none for a bot on its own or a guest browser", () => {
    expect(browserMatesOf(bots, "payroll")).toEqual(["infra"]);
    expect(browserMatesOf(bots, "notes")).toEqual([]);
    expect(browserMatesOf(bots, "audit")).toEqual([]);
    expect(browserMatesOf(bots, "scout")).toEqual([]);
  });

  it("keeps a login saved from a sign-in card to every bot that browser signs in, so it fills for the bot that asked", async () => {
    const { store, logins, place } = world();
    expect(logins.cardBots("payroll")).toEqual(["payroll", "infra"]);
    expect(logins.cardBots("notes")).toEqual(["notes"]);
    expect(logins.cardBots("scout")).toEqual(["scout"]);
    store.create({ ...place, username: "from-card", password: "x", source: "card", bots: logins.cardBots("payroll") });
    expect((await logins.candidates("payroll", "capacity.example")).map((login) => login.username)).toEqual(["from-card"]);
  });

  it("fills a login kept to one guest bot for that bot alone", async () => {
    const { store, logins, place } = world();
    store.create({ ...place, username: "guest-only", password: "x", source: "settings", bots: ["scout"] });
    expect(logins.sitesFor("scout").map((login) => login.username)).toEqual(["guest-only"]);
    expect(logins.sitesFor("visitor")).toEqual([]);
    expect(loginHeldBackFor({ bots: ["scout"] }, bots)).toEqual([]);
  });

  it("is never filled into a browser a bot it isn't kept to also signs in through", async () => {
    const { store, logins, place } = world();
    store.create({ ...place, username: "ops", password: "hunter2", source: "settings", bots: ["payroll"] });
    expect(logins.sitesFor("payroll")).toEqual([]);
    expect(await logins.candidates("payroll", "capacity.example")).toEqual([]);
    expect(logins.sitesFor("infra")).toEqual([]);
    expect(loginHeldBackFor({ bots: ["payroll"] }, bots)).toEqual(["payroll"]);
  });

  it("fills when every bot on the browser may use it, when it is for every bot, and for a bot with its own browser", async () => {
    const { store, logins, place } = world();
    store.create({ ...place, username: "both", password: "a", source: "settings", bots: ["payroll", "infra"] });
    store.create({ ...place, username: "everyone", password: "b", source: "settings", bots: "all" });
    store.create({ ...place, username: "notes-only", password: "c", source: "settings", bots: ["notes"] });
    expect(logins.sitesFor("payroll").map((login) => login.username)).toEqual(["both", "everyone"]);
    expect((await logins.candidates("infra", "capacity.example")).map((login) => login.username)).toEqual(["both", "everyone"]);
    expect(logins.sitesFor("notes").map((login) => login.username)).toEqual(["everyone", "notes-only"]);
    expect(loginHeldBackFor({ bots: ["payroll", "infra"] }, bots)).toEqual([]);
    expect(loginHeldBackFor({ bots: "all" }, bots)).toEqual([]);
  });
});

