// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { registerDesktopPrefs } from "../../electron/desktop-prefs.mjs";
import { setLocale } from "@/lib/i18n";

vi.mock("@/components/EngineLibrary", () => ({ engineReady: () => true }));
const ph = vi.hoisted(() => {
  const ph = {
    loads: 0,
    calls: [] as unknown[][],
    module: () => {
      ph.loads += 1;
      return { default: {
        init: () => {}, has_opted_out_capturing: () => false, opt_in_capturing: () => {}, opt_out_capturing: () => {},
        register: () => {}, unregister: () => {},
        capture: (event: string, props?: unknown) => void ph.calls.push(["capture", event, props]),
        identify: (id: string, props?: unknown) => void ph.calls.push(["identify", id, props]),
      } };
    },
  };
  return ph;
});
vi.mock("posthog-js", () => ph.module());
import { CloudProPopup, cloudProCloudPageView, cloudProPopupView, otherDialogOpen, useOtherDialogOpen, type CloudProPopupView } from "./CloudProPopup";
import { Spotlight } from "./onboarding/Spotlight";

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 16);
const plans = [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const onPlan = (tier: string | undefined, extra: Partial<CloudAccountState> = {}): CloudAccountState =>
  ({ ...free, entitlement: { plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const running = { state: "active" as const, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none" as const };

beforeEach(() => setLocale("en"));

const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8").replace(/\r\n/g, "\n");
type Ogb = NonNullable<Window["ogb"]>;
const MY_CLOUD = "https://omb-u-1.fly.dev";
const port = (number: number) => `http://127.0.0.1:${number}`;
type Desktop = (origin: string) => Ogb;
// One desktop: main's real record, and the real preload for a page of its window: this computer's, on whichever port
// the app got that launch, or My Cloud's.
function oneDesktop(): Desktop {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, (event: { origin: string; returnValue?: unknown }) => void>();
  let saved: unknown = null;
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler), on: (channel, listener) => void listeners.set(channel, listener) },
    read: () => saved, write: value => { saved = JSON.parse(JSON.stringify(value)); },
    page: event => (event as { origin: string }).origin === MY_CLOUD ? "cloud" : "local", cloudOffered: async () => true,
  });
  return origin => {
    let ogb: Ogb | undefined;
    vm.runInNewContext(PRELOAD, {
      process: { platform: "darwin", argv: [`--omb-local-origin=${origin === MY_CLOUD ? port(8799) : origin}`, "--omb-company-desktop=1"] },
      location: { origin }, navigator: {}, TextEncoder,
      require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name: string, value: Ogb) => { ogb = value; } },
        ipcRenderer: { on() {}, removeListener() {}, send() {},
          sendSync: (channel: string) => { const event: { origin: string; returnValue?: unknown } = { origin }; listeners.get(channel)?.(event); return event.returnValue; },
          invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ origin }, ...args) } }),
    });
    return ogb!;
  };
}
const START = location.href;
const setURL = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

describe("what the popup offers, by plan", () => {
  it("waits while the plan or the offer loads, and for a later launch when the Cloud can't be reached", () => {
    for (const account of [null, { status: "signed-out", message: "restoring" }, { status: "connecting" }] as const) {
      expect(cloudProPopupView(account as CloudAccountState | null, TRIAL_OFFER), JSON.stringify(account)).toBe("loading");
    }
    expect(cloudProPopupView({ status: "signed-out" }, undefined)).toBe("loading");
    expect(cloudProPopupView({ status: "signed-out" }, null)).toBe("offline");
    expect(cloudProPopupView({ status: "unavailable", lastPlan: { tier: "pro", active: true } }, TRIAL_OFFER)).toBe("offline");
  });

  it("no plan: the in-app checkout, with the trial, prices, credit and money-back from the live offer", () => {
    const signedOut = cloudProPopupView({ status: "signed-out" }, TRIAL_OFFER) as CloudProPopupView;
    expect(signedOut).toMatchObject({ primary: { via: "add-cloud", label: "Start free trial" }, seePlans: true, plan: "none", signedIn: false, email: null,
      badge: "Free for 7 days", price: "Then from $15/month + tax. Cancel any time.", moneyBack: "14-day money-back on every plan.", current: null });
    expect(signedOut.points).toContain("$5 of Claude credit to start");
    const costlier = { ...PLAIN_OFFER, plans: PLAIN_OFFER.plans.map(plan => ({ ...plan, amount: plan.amount + 1000 })) };
    expect(cloudProPopupView(free, costlier)).toMatchObject({ primary: { via: "add-cloud", label: "Upgrade to Cloud Pro" },
      plan: "none", signedIn: true, email: "person@example.test", badge: null, price: "MausBot Cloud plans from $25/month + tax.", moneyBack: null });
    expect((cloudProPopupView(free, costlier) as CloudProPopupView).points).toContain("Voice and cloud desktops by Boat included");
  });

  it("a plan: Manage plan in Settings → MausBot Cloud for every plan, no Compare plans, never a checkout, a price or the browser", () => {
    const cases: Array<[CloudAccountState, string, string, string | null]> = [
      [onPlan("personal"), "personal", "Manage plan", "Personal active · verified by MausBot Cloud"],
      [onPlan("pro", { trial: running }), "trial", "Manage plan", "Pro free trial · verified by MausBot Cloud"],
      [onPlan("pro"), "pro", "Manage plan", "Pro active · verified by MausBot Cloud"],
      [onPlan(undefined), "pro", "Manage plan", "Pro active · verified by MausBot Cloud"],
      [onPlan("max"), "max", "Manage plan", "Max active · verified by MausBot Cloud"],
      [onPlan("ultra"), "other", "Manage plan", "Cloud active · verified by MausBot Cloud"],
      [{ ...free, purchase: { state: "confirming" } }, "none", "Manage plan", "MausBot Cloud · payment received"],
      [{ ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 } }, "none", "Manage plan", "Pro · not active right now"],
      [{ status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, "unknown", "Manage plan", "Sign in again to use the Cloud on this computer. Your plan is not affected."],
      [{ status: "signed-out", message: "restore-removed" }, "none", "Manage plan", null],
    ];
    for (const [account, plan, label, current] of cases) {
      const view = cloudProPopupView(account, TRIAL_OFFER) as CloudProPopupView;
      expect(view, plan).toMatchObject({ primary: { via: "settings", label }, seePlans: false, plan, current, badge: null, price: null, moneyBack: null });
      expect(view.signedIn, plan).toBe(account.status === "connected");
    }
  });

  it("My Cloud's page: a plan manages in that page's Settings, never the plan page in the browser; a plan being checked waits; no plan read offers none", () => {
    const cases: Array<[CloudPlanSnapshot, string, boolean, string]> = [
      [{ status: "paid", tier: "personal" }, "personal", true, "Personal active · verified by MausBot Cloud"],
      [{ status: "paid", tier: "pro", trial: running }, "trial", true, "Pro free trial · verified by MausBot Cloud"],
      [{ status: "paid" }, "pro", true, "Pro active · verified by MausBot Cloud"],
      [{ status: "paid", tier: "ultra" }, "other", true, "Cloud active · verified by MausBot Cloud"],
      [{ status: "attention", tier: "max" }, "none", true, "Max · not active right now"],
      [{ status: "attention" }, "none", true, "MausBot Cloud · not active right now"],
      [{ status: "signin", tier: "pro" }, "unknown", false, "Sign in again to use the Cloud on this computer. Your plan is not affected."],
    ];
    for (const [snapshot, plan, signedIn, current] of cases) {
      expect(cloudProCloudPageView(snapshot), plan).toMatchObject({ primary: { via: "settings", label: "Manage plan" }, seePlans: false, plan, signedIn,
        email: null, current, badge: null, price: null, moneyBack: null });
    }
    expect(cloudProCloudPageView(null)).toBe("loading");
    expect(cloudProCloudPageView({ status: "checking", tier: "pro" })).toBe("offline");
    expect(cloudProCloudPageView({ status: "none" })).toBe("offline");
  });

});

describe("the popup as a dialog", () => {
  let root: Root, container: HTMLElement, opener: HTMLButtonElement;
  const view = cloudProPopupView({ status: "signed-out" }, TRIAL_OFFER) as CloudProPopupView;
  const actions = { onPrimary: vi.fn(), onSeePlans: vi.fn(), onNotNow: vi.fn(), onClose: vi.fn() };
  const show = (props: Partial<Parameters<typeof CloudProPopup>[0]> = {}) => flushSync(() => root.render(createElement(CloudProPopup, { view, ...actions, ...props })));
  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event;
  };
  const focused = () => (document.activeElement as HTMLElement).textContent || document.activeElement!.getAttribute("aria-label");
  beforeEach(() => {
    vi.clearAllMocks();
    opener = document.body.appendChild(document.createElement("button"));
    opener.textContent = "composer"; opener.focus();
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });
  afterEach(() => { root.unmount(); document.body.replaceChildren(); });

  it("is a labelled modal dialog that takes focus at its title, keeps Tab inside and gives focus back when it goes", () => {
    show();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("MausBot Cloud Pro");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toContain("Then from $15/month + tax.");
    expect(document.activeElement!.id).toBe("cloud-pro-popup-title");
    const order: Array<string | null> = [];
    for (let i = 0; i < 5; i++) { expect(press("Tab").defaultPrevented).toBe(true); order.push(focused()); }
    expect(order).toEqual(["Start free trial", "Compare plans", "Not now", "Close", "Start free trial"]);
    press("Tab", true); expect(focused()).toBe("Close");
    flushSync(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it("Escape, the X and a press outside close it; a press inside does not; each button does its own thing", () => {
    show();
    const escape = press("Escape");
    expect(escape.defaultPrevented).toBe(true); expect(actions.onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.firstElementChild!, dialog = container.querySelector('[role="dialog"]')!;
    dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(actions.onClose).toHaveBeenCalledTimes(1);
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(actions.onClose).toHaveBeenCalledTimes(2);
    const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name)!;
    button("Close").click(); expect(actions.onClose).toHaveBeenCalledTimes(3);
    button("Start free trial").click(); expect(actions.onPrimary).toHaveBeenCalledOnce();
    button("Compare plans").click(); expect(actions.onSeePlans).toHaveBeenCalledOnce();
    button("Not now").click(); expect(actions.onNotNow).toHaveBeenCalledOnce();
    // A payer has no plans to compare in the app yet: no Compare plans link.
    show({ view: cloudProPopupView(onPlan("pro"), TRIAL_OFFER) as CloudProPopupView });
    expect([...container.querySelectorAll("button")].map(item => item.textContent)).not.toContain("Compare plans");
  });

  it("knows when another dialog is open, and notices it opening and closing", () => {
    vi.useFakeTimers();
    try {
      const seen: boolean[] = [];
      const Probe = () => { seen.push(useOtherDialogOpen(true)); return null; };
      show();
      expect(otherDialogOpen()).toBe(false);
      flushSync(() => createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(Probe)));
      expect(seen.at(-1)).toBe(false);
      const other = document.body.appendChild(document.createElement("div"));
      other.setAttribute("aria-modal", "true");
      expect(otherDialogOpen()).toBe(true);
      flushSync(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(true);
      other.remove();
      flushSync(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("any dialog on screen counts, modal or not, the tour's cards and the card that says a new Cloud is set up; one not shown or its own does not", () => {
    show();
    expect(otherDialogOpen()).toBe(false);
    for (const [attribute, value] of [["role", "dialog"], ["role", "alertdialog"], ["aria-modal", "true"], ["data-tour-card", ""], ["data-cloud-setup-ready", ""]]) {
      const other = document.body.appendChild(document.createElement("div"));
      other.setAttribute(attribute!, value!);
      expect(otherDialogOpen(), `${attribute}=${value}`).toBe(true);
      other.style.display = "none";
      expect(otherDialogOpen(), `not shown: ${attribute}=${value}`).toBe(false);
      other.remove();
    }
    const inside = container.querySelector('[role="dialog"]')!.appendChild(document.createElement("div"));
    inside.setAttribute("role", "alertdialog");
    expect(otherDialogOpen(), "inside the popup").toBe(false);
  });

  it("the first conversation's spotlight is a dialog it waits for, and an Escape meant for the spotlight reaches it", () => {
    const spotRoot = createRoot(document.body.appendChild(document.createElement("div")));
    const gotIt = vi.fn();
    flushSync(() => spotRoot.render(createElement(Spotlight, { anchor: null, placement: "below", primary: { label: "Got it", onClick: gotIt }, onDone: gotIt, children: "Approve this step" })));
    expect(document.querySelector('[role="dialog"]')!.getAttribute("aria-modal"), "the spotlight is not modal").toBeNull();
    expect(otherDialogOpen()).toBe(true);
    const spotButton = [...document.querySelectorAll("button")].find(button => button.textContent === "Got it")!;
    show(); spotButton.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    spotButton.dispatchEvent(escape);
    expect(actions.onClose).not.toHaveBeenCalled(); expect(escape.defaultPrevented).toBe(false);
    expect(gotIt).toHaveBeenCalledOnce();
    expect(press("Tab").defaultPrevented, "nor does it pull Tab out of the spotlight").toBe(false);
    expect(document.activeElement).toBe(spotButton);
    spotRoot.unmount();
  });

  it("the calendar's Quick create (a dialog with only a label) counts too", () => {
    const quick = document.body.appendChild(document.createElement("div"));
    quick.setAttribute("role", "dialog"); quick.setAttribute("aria-label", "Quick create");
    quick.appendChild(document.createElement("input")).focus();
    expect(otherDialogOpen()).toBe(true);
    quick.remove();
    expect(otherDialogOpen()).toBe(false);
  });

  it("gives focus back only while it still has it, or nothing does", () => {
    show();
    const other = document.body.appendChild(document.createElement("input"));
    other.focus();
    flushSync(() => root.render(null));
    expect(document.activeElement, "focus that moved on stays where it went").toBe(other);
    show(); expect(document.activeElement!.id).toBe("cloud-pro-popup-title");
    document.body.focus(); (document.activeElement as HTMLElement | null)?.blur();
    flushSync(() => root.render(null));
    expect(document.activeElement, "lost focus goes back to where it was").toBe(other);
  });
});

describe("who clicked, through the app's analytics", () => {
  async function fresh(enabled: boolean) {
    const stored = new Map<string, string>(enabled ? [] : [["omb-analytics-opt-out", "1"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
    vi.resetModules();
    vi.doMock("posthog-js", () => ph.module());
    ph.loads = 0; ph.calls = [];
    const analytics = await import("@/lib/analytics");
    await analytics.initAnalytics();
    const { reportCloudProPopup } = await import("./CloudProPopup");
    return reportCloudProPopup;
  }
  const sent = () => ph.calls.filter(([kind, event]) => kind === "identify" || event === "cloud_pro_popup" || event === "email_submitted");
  const person = { plan: "none" as const, signedIn: true, email: "person@example.test" };
  const identify = ["identify", "person@example.test", { email: "person@example.test" }];
  // A page of the desktop's window at one origin: that origin's own storage, and the desktop's bridge.
  async function pageOn(desktop: Desktop, origin: string, stored: Map<string, string>) {
    setURL(`${origin}/`);
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
    (window as { ogb?: Ogb }).ogb = desktop(origin);
    vi.resetModules();
    vi.doMock("posthog-js", () => ph.module());
    ph.loads = 0; ph.calls = [];
    const analytics = await import("@/lib/analytics");
    await analytics.initAnalytics();
    return { analytics, report: (await import("./CloudProPopup")).reportCloudProPopup };
  }
  afterEach(() => { vi.unstubAllGlobals(); delete (window as { ogb?: Ogb }).ogb; setURL(START); });

  it("a click by someone signed in is tied to their Cloud account's email first; showing, Not now and close never are", async () => {
    const report = await fresh(true);
    for (const action of ["upgrade", "manage", "see_plans"] as const) report(action, person, "local");
    for (const action of ["shown", "not_now", "close"] as const) report(action, person, "local");
    report("upgrade", { plan: "none", signedIn: false, email: null }, "local");
    const event = (action: string, signedIn = true) => ["capture", "cloud_pro_popup", { action, plan: "none", signed_in: signedIn, page: "local" }];
    expect(sent()).toEqual([identify, event("upgrade"), identify, event("manage"), identify, event("see_plans"),
      event("shown"), event("not_now"), event("close"), event("upgrade", false)]);
  });

  it("an opt-out made on port 8799 holds when the app gets 18799: a click there sends nothing, not even the email", async () => {
    const desktop = oneDesktop();
    const first = await pageOn(desktop, port(8799), new Map());
    first.analytics.setAnalyticsEnabled(false);
    const second = await pageOn(desktop, port(18799), new Map());
    expect(second.analytics.analyticsEnabled()).toBe(false);
    second.report("manage", person, "local");
    expect(ph.loads).toBe(0); expect(ph.calls).toEqual([]);
  });

  it("an opt-out kept in one port's storage before the desktop kept it moves there the first time that page runs", async () => {
    const desktop = oneDesktop();
    await pageOn(desktop, port(8799), new Map([["omb-analytics-opt-out", "1"]]));
    expect(ph.loads).toBe(0);
    const second = await pageOn(desktop, port(18799), new Map());
    expect(second.analytics.analyticsEnabled()).toBe(false);
    second.report("upgrade", person, "local");
    expect(ph.calls).toEqual([]);
  });

  it("the desktop's latest choice wins over an older one left in a port's storage", async () => {
    const desktop = oneDesktop();
    const first = await pageOn(desktop, port(8799), new Map([["omb-analytics-opt-out", "1"]]));
    first.analytics.setAnalyticsEnabled(true);
    const second = await pageOn(desktop, port(28799), new Map([["omb-analytics-opt-out", "1"]]));
    expect(second.analytics.analyticsEnabled()).toBe(true);
    second.report("manage", person, "local");
    expect(sent()).toEqual([identify, ["capture", "cloud_pro_popup", { action: "manage", plan: "none", signed_in: true, page: "local" }]]);
  });

  it("with no switch kept yet, a page on another port than the first counts a click without the email: the first port's storage may hold an older opt-out", async () => {
    const desktop = oneDesktop();
    const fallback = await pageOn(desktop, port(18799), new Map());
    expect(fallback.analytics.analyticsEnabled(), "this port's storage holds no choice").toBe(true);
    fallback.report("upgrade", person, "local");
    const upgrade = ["capture", "cloud_pro_popup", { action: "upgrade", plan: "none", signed_in: true, page: "local" }];
    expect(sent()).toEqual([upgrade]);
    const first = await pageOn(desktop, port(8799), new Map());
    first.report("upgrade", person, "local");
    expect(sent(), "the first port's own storage holds no opt-out").toEqual([identify, upgrade]);
    first.analytics.setAnalyticsEnabled(true);
    const later = await pageOn(desktop, port(28799), new Map());
    later.report("upgrade", person, "local");
    expect(sent(), "once the desktop keeps a switch, every port knows").toEqual([identify, upgrade]);
  });

  it("turned off in the desktop app, My Cloud's page in its window starts with it off: its popup sends nothing, and it cannot turn the desktop's switch on", async () => {
    const desktop = oneDesktop();
    const local = await pageOn(desktop, port(8799), new Map());
    local.analytics.setAnalyticsEnabled(false);
    const cloud = await pageOn(desktop, MY_CLOUD, new Map());
    expect(cloud.analytics.analyticsEnabled()).toBe(false);
    const view = cloudProCloudPageView({ status: "paid", tier: "pro" }) as CloudProPopupView;
    cloud.report("shown", view, "my_cloud"); cloud.report("manage", view, "my_cloud");
    expect(ph.loads).toBe(0); expect(ph.calls).toEqual([]);
    expect(window.ogb?.desktopAnalytics?.set, "only This computer's page sets it").toBeUndefined();
    await pageOn(desktop, port(18799), new Map()).then(page => page.analytics.setAnalyticsEnabled(true));
    for (const [stored, enabled] of [[new Map(), true], [new Map([["omb-analytics-opt-out", "1"]]), false]] as const) {
      const again = await pageOn(desktop, MY_CLOUD, stored);
      expect(again.analytics.analyticsEnabled(), "turned back on in the desktop app, My Cloud's page follows its own switch").toBe(enabled);
    }
  });

  it("sends nothing at all with usage analytics off", async () => {
    const report = await fresh(false);
    for (const action of ["shown", "upgrade", "manage", "see_plans", "not_now", "close"] as const) report(action, person, "local");
    expect(ph.loads).toBe(0);
    expect(ph.calls).toEqual([]);
  });
});
