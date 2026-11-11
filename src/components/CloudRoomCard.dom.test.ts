// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudRoom, CloudUsage } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ bots: [] as Array<{ id: string; busy?: boolean }> }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: store.bots, config: { cloudHome: true } }, dispatch: vi.fn() }) }));
import { CloudRoomCard } from "./CloudRoomCard";

// The room card on the person's own Cloud, rendered as the sidebar renders it, against a bridge that answers as main does.
const usage: CloudUsage = { tier: "starter", resetsAt: Date.UTC(2026, 10, 1), meters: [{ kind: "storage", used: 2, max: 10 }], upgrades: [{ tier: "pro", amount: 4900 }, { tier: "max", amount: 9900 }] };
const memory: CloudRoom = { id: "offer-1", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 0 },
  plan: { tier: "pro", amount: 4900, memoryMb: 4096, fromMemoryMb: 2048, diskGb: 100, fromDiskGb: 10 } };
const PREVIEW = { plan: "pro", from: "starter", trial: false, price: 4900, chargeNow: 3120, tax: 0, nextBillingAt: Date.UTC(2026, 10, 18), expiresAt: Date.now() + 600_000 };
let container: HTMLDivElement, root: Root, snapshot: CloudPlanSnapshot;
function bridge(): CloudPlanBridge & Record<"upgradePreview" | "upgrade" | "roomNotNow" | "restartNow", ReturnType<typeof vi.fn>> {
  return { state: vi.fn(async () => snapshot), manage: vi.fn(async () => {}),
    upgradePreview: vi.fn(async () => ({ outcome: "preview" as const, preview: PREVIEW })),
    upgrade: vi.fn(async () => { snapshot = { status: "paid", tier: "pro", usage: { ...usage, tier: "pro", upgrades: [{ tier: "max", amount: 9900 }] } }; return { outcome: "upgraded" as const, tier: "pro" }; }),
    roomNotNow: vi.fn(async () => true), restartNow: vi.fn(async () => "restarting" as const) } as never;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  globalThis.localStorage?.clear();
  store.bots = [{ id: "chief" }];
  snapshot = { status: "paid", tier: "starter", usage, room: memory };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const show = async (plan: CloudPlanBridge) => { vi.stubGlobal("window", Object.assign(window, { ogb: { cloudPlan: plan } })); await act(async () => { root.render(createElement(CloudRoomCard)); }); await settle(); };
const card = () => document.querySelector<HTMLElement>("[data-cloud-room-card]");
const text = () => card()?.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent === label);
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); await settle(); };

describe("the room card", () => {
  it("says what ran short and what fixes it, and its Upgrade goes through the usual preview and confirmation, then offers Restart now", async () => {
    const plan = bridge();
    await show(plan);
    expect(card()?.getAttribute("data-cloud-room-card")).toBe("upgrade");
    expect(text()).toBe("This Cloud is short on room3 tasks waited 6 minutes for memory today.Pro has twice the memory. $49 a month. Today you pay only for the rest of this month.UpgradeNot now");
    await click(button("Upgrade"));
    expect(plan.upgradePreview).toHaveBeenCalledExactlyOnceWith("pro", "app_room");
    expect(plan.upgrade).not.toHaveBeenCalled();
    await click(button("Upgrade to Pro"));
    expect(plan.upgrade).toHaveBeenCalledExactlyOnceWith("pro", "app_room");
    expect(card()?.getAttribute("data-cloud-room-card")).toBe("upgraded");
    expect(text()).toContain("You're on Pro now. This Cloud gets its new size the next time it's not busy.");
    await click(button("Restart now"));
    expect(plan.restartNow).toHaveBeenCalledOnce();
    expect(text()).toBe("Restarting this Cloud with its new size. It's back in about a minute.");
  });

  it("forgets an upgrade once the session that made it ends, so Restart now never reaches another account's Cloud", async () => {
    const plan = bridge();
    await show(plan);
    await click(button("Upgrade"));
    await click(button("Upgrade to Pro"));
    expect(button("Restart now")).toBeTruthy();
    snapshot = { status: "none" };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    snapshot = { status: "paid", tier: "starter", usage };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(button("Restart now")).toBeUndefined();
    expect(card()).toBeNull();
  });

  it("shows no offer whose plan the session's upgrades don't list: its Upgrade could never go through", async () => {
    snapshot = { status: "paid", tier: "starter", usage: { ...usage, upgrades: [{ tier: "max", amount: 9900 }] }, room: memory };
    await show(bridge());
    expect(card()).toBeNull();
  });

  it("waits while any bot is working, and Not now hides it here and tells the Admin", async () => {
    store.bots = [{ id: "chief", busy: true }];
    const plan = bridge();
    await show(plan);
    expect(card()).toBeNull();
    store.bots = [{ id: "chief" }];
    await act(async () => { root.render(createElement(CloudRoomCard)); });
    await settle();
    expect(card()).not.toBeNull();
    await click(button("Not now"));
    expect(plan.roomNotNow).toHaveBeenCalledExactlyOnceWith("offer-1");
    expect(card()).toBeNull();
    expect(plan.upgradePreview).not.toHaveBeenCalled();
  });

  it("shows the top plan a tip and no Upgrade, and nothing while the usage card is showing", async () => {
    const plan = bridge();
    snapshot = { status: "paid", tier: "max", usage: { ...usage, tier: "max", upgrades: [] }, room: { id: "tip-1", cause: { kind: "disk", usedGb: 87.5, capGb: 100 }, tip: true } };
    await show(plan);
    expect(card()?.getAttribute("data-cloud-room-card")).toBe("tip");
    expect(text()).toBe("This Cloud is almost out of space87.5 GB of 100 GB used.You're on the biggest plan. To free up space, delete files and folders you no longer need.Got it");
    expect(button("Upgrade")).toBeUndefined();
    await click(button("Got it"));
    expect(plan.roomNotNow).toHaveBeenCalledExactlyOnceWith("tip-1");
    await act(async () => root.unmount()); root = createRoot(container);
    snapshot = { status: "paid", tier: "starter", usage: { ...usage, meters: [{ kind: "computerHours", used: 95, max: 100 }] }, room: { ...memory, id: "offer-2" } };
    await show(bridge());
    expect(card()).toBeNull();
  });
});
