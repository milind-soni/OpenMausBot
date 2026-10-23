import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsEnabled, initAnalytics, optAction, setAnalyticsEnabled } from "./analytics";
import { appVersion } from "./app-links";

// `loads` counts evaluations of posthog-js (an opted-out session must leave it at 0); `calls` is what would reach PostHog.
const ph = vi.hoisted(() => {
  const ph = {
    loads: 0,
    fail: false,
    initThrows: false,
    storedOptOut: false,
    calls: [] as string[],
    captured: [] as Array<{ event: string; props: unknown }>,
    options: [] as Record<string, unknown>[],
    registered: [] as Record<string, unknown>[],
    unregistered: [] as string[],
    optIns: [] as unknown[],
    module: () => {
      if (ph.fail) throw new Error("chunk failed to load");
      ph.loads += 1;
      let optedOut = ph.storedOptOut;
      return {
        default: {
          init: (_token: string, options: Record<string, unknown>) => {
            if (ph.initThrows) throw new Error("init failed");
            ph.calls.push("init");
            ph.options.push(options);
          },
          has_opted_out_capturing: () => optedOut,
          opt_in_capturing: (options?: unknown) => {
            optedOut = false;
            ph.calls.push("opt_in_capturing");
            ph.optIns.push(options);
          },
          opt_out_capturing: () => {
            optedOut = true;
            ph.calls.push("opt_out_capturing");
          },
          register: (properties: Record<string, unknown>) => { ph.calls.push("register"); ph.registered.push(properties); },
          unregister: (key: string) => void ph.unregistered.push(key),
          capture: (event: string, props?: unknown) => {
            ph.calls.push(`capture ${event}`);
            ph.captured.push({ event, props });
          },
          identify: (id: string) => void ph.calls.push(`identify ${id}`),
        },
      };
    },
  };
  return ph;
});
vi.mock("posthog-js", () => ph.module());

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
const baseStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => {
  store.clear();
  ph.loads = 0;
  ph.fail = false;
  ph.initThrows = false;
  ph.storedOptOut = false;
  ph.calls = [];
  ph.captured = [];
  ph.options = [];
  ph.registered = [];
  ph.unregistered = [];
  ph.optIns = [];
});
// Restored in afterEach: an inline restore would be skipped when an assertion fails mid-test.
afterEach(() => vi.stubGlobal("localStorage", baseStorage));

// resetModules keeps the mocked posthog-js cached, so it is registered again and `loads` counts this graph only.
async function freshAnalytics() {
  vi.resetModules();
  vi.doMock("posthog-js", () => ph.module());
  return import("./analytics");
}

const OPENED = ["init", "register", "capture app_first_open", "capture app_opened"];

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
    expect(optAction(false, false)).toBe("none");
  });
});

describe("the stored choice", () => {
  it("is on for a fresh install", () => {
    expect(analyticsEnabled()).toBe(true);
  });

  it("survives a restart once opted out", () => {
    setAnalyticsEnabled(false);
    expect(analyticsEnabled()).toBe(false);
  });

  it("can be turned back on", async () => {
    setAnalyticsEnabled(false);
    setAnalyticsEnabled(true);
    expect(analyticsEnabled()).toBe(true);
    // Let init finish here rather than write the install marker into the next test.
    await initAnalytics();
  });

  it("holds an opt-out for the session even when the write is rejected", async () => {
    const fresh = await freshAnalytics();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });

    fresh.setAnalyticsEnabled(false);
    expect(fresh.analyticsEnabled()).toBe(false);
    await fresh.initAnalytics();
    expect(ph.loads).toBe(0);
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
  it("returns before loading the client or touching the install marker", async () => {
    store.set("omb-analytics-opt-out", "1");
    const fresh = await freshAnalytics();

    expect(fresh.analyticsEnabled()).toBe(false);
    await fresh.initAnalytics();
    fresh.track("onboarding_step");
    fresh.identifyEmail("someone@example.com");

    expect(ph.loads).toBe(0);
    expect(ph.calls).toEqual([]);
    expect(store.get("omb-installed")).toBeUndefined();
  });
});

describe("loading the client", () => {
  it("leaves posthog-js out of the startup bundle until initAnalytics runs", async () => {
    const fresh = await freshAnalytics();
    expect(ph.loads).toBe(0);
    await fresh.initAnalytics();
    expect(ph.loads).toBe(1);
  });

  it("says which app sent every event, and from which page, before the first one", async () => {
    const fresh = await freshAnalytics();
    await fresh.initAnalytics();
    expect(ph.registered).toEqual([{ app_version: appVersion(), surface: "server" }]);
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(ph.calls.indexOf("register")).toBeLessThan(ph.calls.indexOf("capture app_first_open"));
    vi.stubGlobal("window", { ogb: { environments: {} } });
    try { expect(fresh.analyticsSurface()).toBe("local"); } finally { vi.unstubAllGlobals(); vi.stubGlobal("localStorage", baseStorage); }
    expect(fresh.analyticsSurface()).toBe("server");
  });

  it("initialises once, with autocapture, surveys and feature flags off", async () => {
    const fresh = await freshAnalytics();
    const first = fresh.initAnalytics();
    expect(fresh.initAnalytics()).toBe(first);
    await first;
    await fresh.initAnalytics();

    expect(ph.calls).toEqual(OPENED);
    expect(ph.options).toHaveLength(1);
    expect(ph.options[0]).toMatchObject({ autocapture: false, disable_surveys: true, advanced_disable_flags: true });
  });

  it("forgets the first page's address that PostHog stored for the person", async () => {
    const fresh = await freshAnalytics();
    await fresh.initAnalytics();
    expect(ph.unregistered).toEqual(["$initial_person_info", "$initial_referrer_info", "$initial_campaign_params"]);
  });

  it("opts back in without PostHog's own $opt_in event, at start and from Settings", async () => {
    ph.storedOptOut = true;
    const fresh = await freshAnalytics();
    await fresh.initAnalytics();
    fresh.setAnalyticsEnabled(false);
    fresh.setAnalyticsEnabled(true);
    expect(ph.calls.filter((call) => call.startsWith("opt_"))).toEqual(["opt_in_capturing", "opt_out_capturing", "opt_in_capturing"]);
    expect(ph.optIns).toEqual([{ captureEventName: false }, { captureEventName: false }]);
  });

  it("sends no address: no URL, host, path, referrer or campaign, on the event or on the person", async () => {
    const fresh = await freshAnalytics();
    await fresh.initAnalytics();
    expect(ph.options[0]).toMatchObject({ save_referrer: false, save_campaign_params: false, disable_capture_url_hashes: true });
    const beforeSend = ph.options[0]!.before_send as (event: unknown) => unknown;
    const page = "https://ada-tenant.mausbot.cloud/?share-computer=cmp_123&utm_source=hn#copy-to";
    const event = {
      uuid: "u", event: "app_snapshot",
      properties: {
        token: "phc_token", distinct_id: "d", app_version: "0.1.111", surface: "server", bots: 3, key_providers: ["boat"], $os: "Mac OS X",
        $current_url: page, $host: "ada-tenant.mausbot.cloud", $pathname: "/", $referrer: "https://www.google.com/?q=ada", $referring_domain: "www.google.com",
        $search_engine: "google", ph_keyword: "ada", utm_source: "hn", utm_campaign: "launch", gclid: "g1", fbclid: "f1", gad_source: "1",
        $session_entry_url: page, $session_entry_host: "ada-tenant.mausbot.cloud", $session_entry_pathname: "/", $session_entry_referrer: "https://www.google.com/",
        $session_entry_referring_domain: "www.google.com", $session_entry_utm_source: "hn", $session_entry_gclid: "g1", $prev_pageview_pathname: "/old",
        $set: { email: "ada@example.com", $current_url: page },
      },
      $set: { email: "ada@example.com", $current_url: page, $pathname: "/", $referrer: "https://www.google.com/", $referring_domain: "www.google.com" },
      $set_once: {
        $initial_current_url: page, $initial_host: "ada-tenant.mausbot.cloud", $initial_pathname: "/", $initial_referrer: "https://www.google.com/",
        $initial_referring_domain: "www.google.com", $initial_utm_source: "hn", $initial_gclid: "g1", $initial_search_engine: "google", $initial_ph_keyword: "ada",
        $current_url: page, $host: "ada-tenant.mausbot.cloud", $referrer: "https://www.google.com/", utm_medium: "social",
      },
    };
    const sent = beforeSend(structuredClone(event));
    expect(sent).toEqual({
      uuid: "u", event: "app_snapshot",
      properties: { token: "phc_token", distinct_id: "d", app_version: "0.1.111", surface: "server", bots: 3, key_providers: ["boat"], $os: "Mac OS X", $set: { email: "ada@example.com" } },
      $set: { email: "ada@example.com" },
      $set_once: {},
    });
    expect(JSON.stringify(sent)).not.toMatch(/mausbot\.cloud|google|share-computer|cmp_123|hn|g1|f1/);
    expect(beforeSend(null)).toBeNull();
  });

  it("delivers calls made while it loads once each, after app_opened, in order", async () => {
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.track("onboarding_step", { step: "hello" });
    fresh.identifyEmail("someone@example.com");
    fresh.track("onboarding_done");
    await loading;

    expect(ph.calls).toEqual([
      ...OPENED,
      "capture onboarding_step",
      "identify someone@example.com",
      "capture email_submitted",
      "capture onboarding_done",
    ]);
  });

  it("drops calls made before initAnalytics, as before", async () => {
    const fresh = await freshAnalytics();
    fresh.track("too_early");
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });

  it("never initialises, and drops the queued email, when switched off mid-load", async () => {
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.identifyEmail("someone@example.com");
    fresh.track("onboarding_step");
    fresh.setAnalyticsEnabled(false);
    await loading;

    expect(ph.calls).toEqual([]);
    expect(store.get("omb-installed")).toBeUndefined();

    fresh.setAnalyticsEnabled(true);
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });

  it("initialises once when switched off and on again mid-load", async () => {
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.track("before_off");
    fresh.setAnalyticsEnabled(false);
    fresh.setAnalyticsEnabled(true);
    fresh.track("after_on");
    await loading;
    await fresh.initAnalytics();

    expect(ph.loads).toBe(1);
    expect(ph.calls).toEqual([...OPENED, "capture after_on"]);
  });

  it("stops a running client when switched off", async () => {
    const fresh = await freshAnalytics();
    await fresh.initAnalytics();
    fresh.setAnalyticsEnabled(false);
    fresh.track("after_off");
    fresh.identifyEmail("someone@example.com");

    expect(ph.calls).toEqual([...OPENED, "opt_out_capturing"]);
  });

  it("stays off without throwing when the library fails to load", async () => {
    ph.fail = true;
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.track("onboarding_step");
    await expect(loading).resolves.toBeUndefined();
    fresh.track("after_failure");
    expect(ph.calls).toEqual([]);

    ph.fail = false;
    fresh.setAnalyticsEnabled(true);
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });

  it("settles quietly, and drops the queue, when the library throws while starting", async () => {
    ph.initThrows = true;
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.identifyEmail("someone@example.com");
    await expect(loading).resolves.toBeUndefined();
    fresh.track("after_failure");
    expect(ph.calls).toEqual([]);

    ph.initThrows = false;
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });
});

describe("app_active", () => {
  const DAY = "omb-analytics-active-day";
  const HOUR = 60 * 60_000;

  // A window showing the app: each load drops the last load's listeners and timers, as a reload does.
  function openPage() {
    const listeners = new Map<string, Array<() => void>>();
    const listen = (type: string, listener: () => void) => void listeners.set(type, [...listeners.get(type) ?? [], listener]);
    const page = {
      visibilityState: "visible" as "visible" | "hidden",
      focused: true,
      fire(type: "focus" | "visibilitychange") {
        for (const listener of listeners.get(type) ?? []) listener();
      },
      async load() {
        listeners.clear();
        // vitest 4.1's clearAllTimers() also puts the faked clock back to the real time.
        const now = Date.now();
        vi.clearAllTimers();
        vi.setSystemTime(now);
        const analytics = await freshAnalytics();
        await analytics.initAnalytics();
        return analytics;
      },
    };
    vi.stubGlobal("document", { get visibilityState() { return page.visibilityState; }, hasFocus: () => page.focused, addEventListener: listen });
    vi.stubGlobal("window", { addEventListener: listen });
    return page;
  }

  let page: ReturnType<typeof openPage>;
  const active = () => ph.captured.filter(({ event }) => event === "app_active");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 23, 9, 0));
    page = openPage();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", baseStorage);
  });

  it("is sent once a day, however often the app loads or comes back into view", async () => {
    await page.load();
    expect(ph.calls).toEqual([...OPENED, "capture app_active"]);
    expect(active()).toEqual([{ event: "app_active", props: { platform: "browser" } }]);
    expect(ph.registered).toEqual([{ app_version: appVersion(), surface: "server" }]);
    expect(store.get(DAY)).toBe("2026-10-23");

    page.fire("focus");
    page.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    await page.load();
    await page.load();
    page.fire("focus");
    vi.setSystemTime(new Date(2026, 9, 23, 23, 59));
    page.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(active()).toHaveLength(1);
    expect(ph.calls.filter((call) => call === "capture app_opened")).toHaveLength(3);
  });

  it("is sent again after midnight by the ten-minute check, then not again that day", async () => {
    vi.setSystemTime(new Date(2026, 9, 23, 23, 55));
    await page.load();
    expect(active()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(active()).toHaveLength(2);
    expect(store.get(DAY)).toBe("2026-10-24");

    await vi.advanceTimersByTimeAsync(5 * HOUR);
    page.fire("focus");
    await page.load();
    expect(active()).toHaveLength(2);
  });

  it("waits for focus on a new day while the window is shown but not in use", async () => {
    await page.load();
    page.focused = false;
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(active()).toHaveLength(1);

    page.focused = true;
    page.fire("focus");
    expect(active()).toHaveLength(2);
    expect(store.get(DAY)).toBe("2026-10-24");
  });

  it("sends nothing while the page is hidden, and counts the day once it is shown", async () => {
    page.visibilityState = "hidden";
    await page.load();
    page.fire("focus");
    await vi.advanceTimersByTimeAsync(30 * HOUR);
    expect(ph.calls).toEqual(OPENED);
    expect(store.has(DAY)).toBe(false);

    page.visibilityState = "visible";
    page.fire("visibilitychange");
    expect(active()).toHaveLength(1);
    expect(store.get(DAY)).toBe("2026-10-24");
  });

  it("sends nothing, loads nothing and stores no day while analytics is off", async () => {
    store.set("omb-analytics-opt-out", "1");
    await page.load();
    page.fire("focus");
    page.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    page.fire("focus");

    expect(ph.loads).toBe(0);
    expect(ph.calls).toEqual([]);
    expect(store.has(DAY)).toBe(false);
  });

  it("stops once switched off mid-session", async () => {
    const analytics = await page.load();
    analytics.setAnalyticsEnabled(false);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    page.fire("focus");
    page.fire("visibilitychange");

    expect(active()).toHaveLength(1);
    expect(store.get(DAY)).toBe("2026-10-23");
  });

  it("keeps to one a day for the session when the day cannot be stored", async () => {
    const refuse = (key: string) => {
      if (key === DAY) throw new Error("denied");
    };
    vi.stubGlobal("localStorage", {
      ...baseStorage,
      getItem: (key: string) => (refuse(key), baseStorage.getItem(key)),
      setItem: (key: string, value: string) => (refuse(key), baseStorage.setItem(key, value)),
    });
    await page.load();
    page.fire("focus");
    page.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(active()).toHaveLength(1);

    vi.setSystemTime(new Date(2026, 9, 24, 8, 0));
    page.fire("focus");
    expect(active()).toHaveLength(2);
  });
});
