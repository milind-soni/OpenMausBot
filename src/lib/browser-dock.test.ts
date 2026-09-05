import { describe, expect, it } from "vitest";

import {
  browserDockAvailable,
  browserDockHasPage,
  browserDockLabel,
  computerPanelHostsBrowser,
  nextBrowserDockState,
} from "./browser-dock";

describe("browser dock state", () => {
  it("stays hidden while the view sits on about:blank", () => {
    expect(nextBrowserDockState({ current: undefined, surfaceOpen: true, url: "about:blank", helpReason: null })).toBeUndefined();
    expect(nextBrowserDockState({ current: undefined, surfaceOpen: true, url: "", helpReason: null })).toBeUndefined();
  });

  it("opens on the first real page", () => {
    expect(nextBrowserDockState({ current: undefined, surfaceOpen: true, url: "https://ledger.example.com/login", helpReason: null })).toBe("open");
  });

  it("keeps a person's collapse across later navigations", () => {
    expect(nextBrowserDockState({ current: "collapsed", surfaceOpen: true, url: "https://ledger.example.com/invoices", helpReason: null })).toBe("collapsed");
  });

  it("reopens a collapsed dock when the bot asks for hands", () => {
    expect(nextBrowserDockState({ current: "collapsed", surfaceOpen: true, url: "https://ledger.example.com/login", helpReason: "the sign-in wants a password" })).toBe("open");
  });

  it("removes the dock when the view closes", () => {
    expect(nextBrowserDockState({ current: "open", surfaceOpen: false, url: "", helpReason: null })).toBeUndefined();
    expect(nextBrowserDockState({ current: "open", surfaceOpen: false, url: "", helpReason: "still asking" })).toBeUndefined();
  });

  it("treats about:blank and empty as no page", () => {
    expect(browserDockHasPage("about:blank")).toBe(false);
    expect(browserDockHasPage(" ")).toBe(false);
    expect(browserDockHasPage(undefined)).toBe(false);
    expect(browserDockHasPage("https://example.com")).toBe(true);
  });
});

describe("browser dock availability", () => {
  const base = { featureEnabled: true, botBrowser: undefined, bridge: true, composer: true, remoteClient: false };

  it("needs the workspace flag, the bridge, and a composer of its own", () => {
    expect(browserDockAvailable(base)).toBe(true);
    expect(browserDockAvailable({ ...base, featureEnabled: false })).toBe(false);
    expect(browserDockAvailable({ ...base, bridge: false })).toBe(false);
    expect(browserDockAvailable({ ...base, composer: false })).toBe(false);
    expect(browserDockAvailable({ ...base, remoteClient: true })).toBe(false);
  });

  it("respects the bot's own browser switch", () => {
    expect(browserDockAvailable({ ...base, botBrowser: false })).toBe(false);
    expect(browserDockAvailable({ ...base, botBrowser: true })).toBe(true);
  });
});

describe("browser dock label", () => {
  it("prefers the page title, then the host", () => {
    expect(browserDockLabel({ url: "https://ledger.example.com/login", title: "Sign in · Ledger" })).toBe("Sign in · Ledger");
    expect(browserDockLabel({ url: "https://ledger.example.com/login", title: "" })).toBe("ledger.example.com");
    expect(browserDockLabel({ url: "about:blank", title: "" })).toBe("");
    expect(browserDockLabel(null)).toBe("");
  });
});

describe("computer panel hosting", () => {
  it("hands the rectangle to the dock only while it is open", () => {
    expect(computerPanelHostsBrowser("open")).toBe(false);
    expect(computerPanelHostsBrowser("collapsed")).toBe(true);
    expect(computerPanelHostsBrowser(undefined)).toBe(true);
  });
});
