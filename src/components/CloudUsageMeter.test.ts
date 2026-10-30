import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudPlanBridge, CloudUpgradePreview } from "../../electron/cloud-account.mjs";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

// The card and the section are rendered as React renders them; the upgrade hook runs with React's state kept here, so
// each click can be followed to exactly what reaches the bridge.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (current: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current }; return f.values[index]; },
}));
import { CloudUsageCardView, CloudUsageSettingsView, confirmUpgrade, previewUpgrade, useUpgrade } from "./CloudUsageMeter";

type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const button = (tree: Node[], text: string) => tree.find(node => node.type === "button" && renderToStaticMarkup(node).includes(text));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const RESETS = Date.UTC(2026, 10, 1);
const usage = (extra: Partial<CloudUsage> = {}): CloudUsage => ({ tier: "pro", resetsAt: RESETS,
  meters: [{ kind: "computerHours", used: 285, max: 300 }, { kind: "voice", used: 12_000, max: 60_000 }, { kind: "storage", used: 41.2, max: 100 }],
  upgrades: [{ tier: "max", amount: 9900 }], ...extra });
const PREVIEW: CloudUpgradePreview = { plan: "max", from: "pro", trial: false, price: 9900, chargeNow: 3300, tax: 0, nextBillingAt: Date.UTC(2026, 10, 18), expiresAt: Date.now() + 600_000 };
const bridge = (overrides: Partial<CloudPlanBridge> = {}) => ({
  state: vi.fn(), manage: vi.fn(async () => {}),
  upgradePreview: vi.fn(async () => ({ outcome: "preview" as const, preview: PREVIEW })),
  upgrade: vi.fn(async () => ({ outcome: "upgraded" as const, tier: "max" })), ...overrides,
}) as unknown as CloudPlanBridge & { manage: ReturnType<typeof vi.fn>; upgradePreview: ReturnType<typeof vi.fn>; upgrade: ReturnType<typeof vi.fn> };

beforeEach(() => { f.values = []; f.index = 0; setLocale("en"); });
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("the sidebar card", () => {
  const card = (props: Partial<Parameters<typeof CloudUsageCardView>[0]> = {}) => {
    const onUpgrade = vi.fn(), onHide = vi.fn(), onSeeAll = vi.fn(), current = usage();
    const all = { usage: current, meters: [current.meters[0]!], band: "near" as const, upgrade: { busy: null, note: null, onUpgrade }, onHide, onSeeAll, ...props };
    return { html: renderToStaticMarkup(createElement(CloudUsageCardView, all)), tree: nodes(CloudUsageCardView(all)), onUpgrade, onHide, onSeeAll };
  };
  it("shows the tight allowance, used of included with its bar, when it starts over, Upgrade and a quiet hide", () => {
    const { html, tree, onUpgrade, onHide, onSeeAll } = card();
    for (const text of ["You&#x27;re close to your plan&#x27;s limit", "Cloud desktop hours", "285 of 300 hours", "Resets on Nov 1.", "Upgrade to Max", "See all usage"]) expect(html).toContain(text);
    expect(html).toContain('role="progressbar"'); expect(html).toContain('aria-valuenow="95"'); expect(html).toContain('data-band="near"');
    expect(html).not.toContain("Voice replies");
    button(tree, "Upgrade to Max")!.props.onClick();
    expect(onUpgrade).toHaveBeenCalledOnce();
    tree.find(node => node.type === "button" && node.props["aria-label"] === "Hide for now")!.props.onClick();
    button(tree, "See all usage")!.props.onClick();
    expect([onHide, onSeeAll].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
  });
  it("says a limit is reached; with no in-app upgrade it opens the Cloud page; on the top plan there is no Upgrade", () => {
    expect(card({ band: "full", meters: [{ kind: "x", used: 5_000, max: 5_000, usedUp: true }] }).html).toContain("You&#x27;ve reached your plan&#x27;s limit");
    const browser = card({ usage: usage({ upgrades: [] }) });
    expect(button(browser.tree, "Upgrade")).toBeTruthy(); expect(browser.html).not.toContain("Upgrade to");
    const top = card({ usage: usage({ tier: "max", upgrades: [] }) });
    expect(top.html).not.toContain(">Upgrade"); expect(top.html).toContain("See all usage");
  });
});

describe("Settings → General", () => {
  const section = (current: CloudUsage) => {
    const onUpgrade = vi.fn(), all = { usage: current, upgrade: { busy: null, note: null, onUpgrade } };
    return { html: renderToStaticMarkup(createElement(CloudUsageSettingsView, all)), tree: nodes(CloudUsageSettingsView(all)), onUpgrade };
  };
  it("lists every allowance with its meter and the plan, and offers each bigger plan", () => {
    const { html, tree, onUpgrade } = section(usage({ tier: "starter", upgrades: [{ tier: "max", amount: 9900 }, { tier: "pro", amount: 4900 }] }));
    for (const text of ["MausBot Cloud usage", "What your Starter plan includes this month", "285 of 300 hours", "12,000 of 60,000 characters", "41.2 of 100 GB",
      "Resets on Nov 1.", "Upgrade to Pro · $49/month", "Upgrade to Max · $99/month"]) expect(html).toContain(text);
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
    button(tree, "Upgrade to Max")!.props.onClick();
    expect(onUpgrade).toHaveBeenCalledWith("max");
  });
  it("on Max says it is the top plan, and a team's plan changes by writing to us", () => {
    expect(section(usage({ tier: "max", upgrades: [] })).html).toContain("You&#x27;re on the top plan.");
    expect(section(usage({ tier: "team", upgrades: [] })).html).toContain("To change your team&#x27;s plan, write to us.");
  });
});

describe("Upgrade", () => {
  it("previews first and changes nothing; only the confirm's own button sends the change, once", async () => {
    const b = bridge(), current = usage(), dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const render = () => { f.index = 0; return useUpgrade(b, current, "app_usage"); };
    render().start();
    await flush();
    expect(b.upgradePreview).toHaveBeenCalledWith("max", "app_usage");
    expect(b.upgrade).not.toHaveBeenCalled();
    const asking = render();
    expect(asking.confirming).toBe(true);
    expect(asking.dialog.props).toMatchObject({ open: true, title: "Upgrade to Max?", confirmLabel: "Upgrade to Max", cancelLabel: "Not now" });
    expect(String(asking.dialog.props.body)).toBe("Max is $99 a month and starts right away. Today you pay $33, the difference for the rest of this billing month. From Nov 18 it's $99 a month, plus any tax.");
    // Not now: nothing is sent, the confirm closes.
    asking.dialog.props.onCancel();
    expect(render().confirming).toBe(false);
    expect(b.upgrade).not.toHaveBeenCalled();
    // Again, and this time Upgrade to Max.
    render().start(); await flush();
    render().dialog.props.onConfirm(); await flush();
    expect(b.upgrade).toHaveBeenCalledOnce();
    expect(b.upgrade).toHaveBeenCalledWith("max", "app_usage");
    const after = render();
    expect([after.confirming, after.note]).toEqual([false, { tone: "good", text: "You're on Max now. Your new allowances are ready." }]);
    // Every meter on the page reads the plan again at once.
    expect(dispatchEvent.mock.calls.map(([event]) => (event as Event).type)).toEqual(["omb:cloud-plan-changed"]);
  });
  it("opens the Cloud page when the app can't change plans, and never previews or changes then", async () => {
    const b = bridge();
    expect(await previewUpgrade(b, usage({ upgrades: [] }), "app_settings")).toEqual({ note: { tone: "info", text: "Your Plan page opened in your browser. You can change your plan there." } });
    expect(b.manage).toHaveBeenCalledOnce();
    expect([b.upgradePreview.mock.calls.length, b.upgrade.mock.calls.length]).toEqual([0, 0]);
  });
  it("says what happened in plain words, and that nothing was charged when nothing was", async () => {
    const refused = bridge({ upgradePreview: vi.fn(async () => ({ outcome: "refused" as const, code: "plan_change_unavailable" as const })) });
    expect(await previewUpgrade(refused, usage(), "app_usage")).toEqual({ note: { tone: "bad",
      text: "Your plan can't be changed from the app right now. Nothing was charged. Open your Plan page to see your options." } });
    const settled = bridge({ upgradePreview: vi.fn(async () => ({ outcome: "settled" as const, status: "pending" as const, tier: "pro" })) });
    expect(await previewUpgrade(settled, usage(), "app_usage")).toEqual({ note: { tone: "info", text: "Your upgrade is going through. This can take a minute." } });
    const declined = bridge({ upgrade: vi.fn(async () => ({ outcome: "refused" as const, code: "payment_failed" as const })) });
    expect(await confirmUpgrade(declined, PREVIEW, "app_usage")).toEqual({ tone: "bad",
      text: "Your payment didn't go through, so your plan hasn't changed. Update your card on your Plan page, then try again." });
    const changed = bridge({ upgrade: vi.fn(async () => ({ outcome: "refused" as const, code: "price_changed" as const })) });
    expect((await confirmUpgrade(changed, PREVIEW, "app_usage")).text).toBe("The price changed since you looked, so nothing was charged. Choose Upgrade to see the new price.");
    const lost = bridge({ upgrade: vi.fn(async () => ({ outcome: "unconfirmed" as const })) });
    expect((await confirmUpgrade(lost, PREVIEW, "app_usage")).text).toBe("We couldn't confirm your upgrade yet. Check back in a minute before trying again.");
  });
});
