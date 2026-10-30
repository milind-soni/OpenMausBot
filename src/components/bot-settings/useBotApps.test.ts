import { afterAll, describe, expect, it, vi } from "vitest";

import type { ToolkitCard } from "../PluginsPanel";

// PluginsPanel reads `window` when it loads; the src suite runs without one.
vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterAll(() => vi.unstubAllGlobals());

const { botAppsFrom } = await import("./useBotApps");
const highlevel = (state: "connected" | "signed-out" | "needs-sign-in" | "connecting" | "unavailable") =>
  ({ state, ...(state === "connected" ? { kind: "oauth" as const, location: { id: "loc_1", name: "Example Profiles" } } : {}) });

const card = (slug: string, label: string): ToolkitCard => ({ slug, label, blurb: `${label} things`, logo: `https://logo.test/${slug}.png`, domain: `${slug}.com` });
const cards = new Map([card("gmail", "Gmail"), card("slack", "Slack")].map((entry) => [entry.slug, entry]));
const inventory = (connected: Record<string, boolean>, authoritative = true) => ({
  authoritative,
  services: Object.fromEntries(Object.entries(connected).map(([slug, on]) => [slug, { connected: on }])),
});

describe("the connected apps as one bot sees them", () => {
  it("is still checking until the account list has loaded", () => {
    expect(botAppsFrom({}, null, cards)).toEqual({ phase: "loading", apps: [], connectedSlugs: [] });
  });

  it("says it does not know, rather than nothing is connected, when the account store could not be read", () => {
    expect(botAppsFrom({}, inventory({ gmail: true }, false), cards)).toEqual({ phase: "unknown", apps: [], connectedSlugs: [] });
  });

  it("lists only connected apps, in name order, with the catalog's name and mark", () => {
    const { phase, apps, connectedSlugs } = botAppsFrom({}, inventory({ slack: true, notion: false, gmail: true }), cards);
    expect(phase).toBe("ready");
    expect(connectedSlugs).toEqual(["gmail", "slack"]);
    expect(apps.map((app) => [app.slug, app.label, app.blurb, app.scope])).toEqual([
      ["gmail", "Gmail", "Gmail things", "write"],
      ["slack", "Slack", "Slack things", "write"],
    ]);
    expect(apps[0]!.card).toEqual({ logo: "https://logo.test/gmail.png", domain: "gmail.com", label: "Gmail" });
  });

  it("names an app by its slug until the catalog knows it", () => {
    const [app] = botAppsFrom({}, inventory({ google_calendar: true }), new Map()).apps;
    expect(app).toMatchObject({ slug: "google_calendar", label: "Google calendar", blurb: "", card: { logo: null, domain: null } });
  });

  it("reads each app's switch from the bot: scoped, read-only, or all off", () => {
    const connected = inventory({ gmail: true, slack: true });
    const scoped = botAppsFrom({ connectorScopes: { apps: { gmail: "read" } } }, connected, cards).apps;
    expect(scoped.map((app) => app.scope)).toEqual(["read", null]);
    const off = botAppsFrom({ composio: false }, connected, cards).apps;
    expect(off.map((app) => app.scope)).toEqual([null, null]);
  });

  it("lists HighLevel, by name and in order, only while the server reports it connected", () => {
    const connected = botAppsFrom({}, inventory({ slack: true, gmail: true }), cards, highlevel("connected"));
    expect(connected.connectedSlugs).toEqual(["gmail", "highlevel", "slack"]);
    const app = connected.apps.find((entry) => entry.slug === "highlevel")!;
    expect(app).toMatchObject({ label: "HighLevel", blurb: "Also Growably and other HighLevel-based CRMs.", scope: "write", card: { logo: null, domain: "gohighlevel.com", label: "HighLevel" } });
    for (const state of ["signed-out", "needs-sign-in", "connecting", "unavailable"] as const) {
      expect(botAppsFrom({}, inventory({ gmail: true }), cards, highlevel(state)).connectedSlugs, state).toEqual(["gmail"]);
    }
    expect(botAppsFrom({}, inventory({ gmail: true }), cards, null).connectedSlugs).toEqual(["gmail"]);
    expect(botAppsFrom({}, inventory({}), cards, highlevel("connected")).apps.map((entry) => entry.slug)).toEqual(["highlevel"]);
  });

  it("reads HighLevel's switch from connectorScopes.apps.highlevel like any other app", () => {
    const connected = inventory({ gmail: true });
    expect(botAppsFrom({ connectorScopes: { apps: { highlevel: "read" } } }, connected, cards, highlevel("connected")).apps.map((app) => [app.slug, app.scope]))
      .toEqual([["gmail", null], ["highlevel", "read"]]);
    expect(botAppsFrom({ connectorScopes: { apps: { gmail: "write" } } }, connected, cards, highlevel("connected")).apps.map((app) => app.scope)).toEqual(["write", null]);
    expect(botAppsFrom({ composio: false }, connected, cards, highlevel("connected")).apps.map((app) => app.scope)).toEqual([null, null]);
  });

  it("still says it does not know when the account store is unreadable, even with HighLevel connected", () => {
    expect(botAppsFrom({}, inventory({}, false), cards, highlevel("connected"))).toEqual({ phase: "unknown", apps: [], connectedSlugs: [] });
  });
});
