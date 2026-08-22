// The opt-out has one job that matters: an install that turned analytics off
// must not talk to PostHog at all. optAction pins the decision, and the
// storage round-trip pins that the choice survives a restart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsEnabled, optAction, setAnalyticsEnabled } from "./analytics";

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
const baseStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => store.clear());
// Tests that swap in a throwing storage get the base one back even when an
// assertion fails mid-test — an inline restore at the end would be skipped.
afterEach(() => vi.stubGlobal("localStorage", baseStorage));

describe("optAction", () => {
  it("initialises on the first opt-in of a session that started off", () => {
    expect(optAction(true, false)).toBe("init");
  });

  it("opts a running client back in rather than initialising twice", () => {
    expect(optAction(true, true)).toBe("opt-in");
  });

  it("stops a running client without waiting for a restart", () => {
    expect(optAction(false, true)).toBe("opt-out");
  });

  it("does nothing when there is no client to stop", () => {
    // The important half: opting out before init must not reach PostHog to
    // tell it so — that request would itself be the leak.
    expect(optAction(false, false)).toBe("none");
  });
});

describe("the stored choice", () => {
  it("is on for a fresh install", () => {
    expect(analyticsEnabled()).toBe(true);
  });

  it("survives a restart once opted out", () => {
    setAnalyticsEnabled(false);
    expect(analyticsEnabled()).toBe(false); // same read a later launch performs
  });

  it("can be turned back on", () => {
    setAnalyticsEnabled(false);
    setAnalyticsEnabled(true);
    expect(analyticsEnabled()).toBe(true);
  });

  it("holds an opt-out for the session even when the write is rejected", async () => {
    // The failure this guards: the setter swallows the write error, the next
    // read finds nothing and answers "enabled", and a later initAnalytics()
    // starts the client the user just switched off.
    vi.resetModules();
    const fresh = await import("./analytics");
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });

    fresh.setAnalyticsEnabled(false);
    expect(fresh.analyticsEnabled()).toBe(false);
    fresh.initAnalytics();
    expect(store.get("omb-installed")).toBeUndefined();
  });

  it("treats unusable storage as a fresh install rather than failing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(analyticsEnabled()).toBe(true);
    expect(() => setAnalyticsEnabled(false)).not.toThrow();
  });
});

describe("initAnalytics while opted out", () => {
  it("returns before touching the client or the install marker", async () => {
    // A fresh module, so the module-scoped `ready` flag starts false: with a
    // used module this test passes on `ready` alone and proves nothing about
    // the opt-out. resetModules is not module mocking — nothing is replaced,
    // the real module is simply loaded again.
    vi.resetModules();
    store.set("omb-analytics-opt-out", "1"); // as a previous session left it
    const fresh = await import("./analytics");

    expect(fresh.analyticsEnabled()).toBe(false);
    fresh.initAnalytics();

    // No client is stubbed on purpose: if init() got past the guard it would
    // reach the real posthog-js and set this marker. Its absence is the
    // proof — and it also means opting back in later still counts the install.
    expect(store.get("omb-installed")).toBeUndefined();
  });
});
