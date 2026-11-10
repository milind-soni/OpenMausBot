// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: { config: { cloudHome: true, botLimit: 5 } as Record<string, unknown>, bots: [] as unknown[] } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: vi.fn() }) }));
vi.mock("./Avatar", () => ({ MausAvatar: () => createElement("i", { "data-mark": "" }), BotAvatar: () => createElement("i", { "data-avatar": "" }) }));
const posted = vi.hoisted(() => [] as Array<{ path: string; body: unknown }>);
vi.mock("@/state/api", () => ({ api: vi.fn(async (path: string, init?: { body?: string }) => { posted.push({ path, body: init?.body ? JSON.parse(init.body) : undefined }); return {}; }) }));
vi.mock("@/lib/app-links", async (original) => ({ ...await original<typeof import("@/lib/app-links")>(), openExternalLink: vi.fn(async () => {}) }));

import { botLimitShown, closeBotLimit, showBotLimit, showCreatedPaused } from "@/lib/bot-limit";
import { openExternalLink } from "@/lib/app-links";
import { setLocale } from "@/lib/i18n";
import { initialAwake } from "./AwakeBotsPicker";
import { BotLimitPopup } from "./BotLimitPopup";

const STARTER = { tier: "starter", resetsAt: 1, meters: [], upgrades: [{ tier: "pro", amount: 4900 }, { tier: "max", amount: 9900 }] };
const made = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `b${i}` }));

let root: Root;
let host: HTMLElement;
const dialog = () => document.querySelector<HTMLElement>("[data-bot-limit-popup]");
const buttons = () => [...dialog()!.querySelectorAll("button")].map((node) => node.textContent?.trim() || node.getAttribute("aria-label"));
const press = (label: string, within: ParentNode = document) => act(async () => {
  [...within.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!.click();
});
const key = (name: string, init: KeyboardEventInit = {}) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })); });

function bridge(snapshot: Record<string, unknown>) {
  return {
    state: vi.fn(async () => snapshot),
    manage: vi.fn(async () => {}),
    upgradePreview: vi.fn(async (plan: string) => ({ outcome: "preview", preview: { plan, trial: false, price: 4900, chargeNow: 3400, tax: 0 } })),
    upgrade: vi.fn(async (plan: string) => ({ outcome: "upgraded", tier: plan })),
  };
}
async function open(plan?: ReturnType<typeof bridge>, reason?: "tasks" | "paused") {
  (window as unknown as { ogb?: unknown }).ogb = plan ? { cloudPlan: plan } : undefined;
  await act(async () => { root.render(createElement(BotLimitPopup)); });
  await act(async () => { showBotLimit(reason); });
  await act(async () => {});
}

beforeEach(() => {
  setLocale("en");
  fixture.state = { config: { cloudHome: true, botLimit: 5 }, bots: made(5) };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { closeBotLimit(); root.unmount(); });
  host.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
});

describe("the bot limit popup", () => {
  it("shows nothing until something opens it", async () => {
    await act(async () => { root.render(createElement(BotLimitPopup)); });
    expect(dialog()).toBeNull();
  });

  it("says they've reached Starter's bots and offers the in-app upgrade, with its price", async () => {
    await open(bridge({ status: "paid", tier: "starter", usage: STARTER }));
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialog()!.querySelector("h2")?.textContent).toBe("You've reached Starter's 5 bots");
    expect(dialog()!.querySelector("p")?.textContent).toBe("To create more, upgrade this Cloud. Every bot you have stays as it is.");
    expect(buttons()).toEqual(["Upgrade to Pro · $49/month", "Not now", "Close"]);
    expect(document.activeElement?.textContent).toBe("Upgrade to Pro · $49/month");
  });

  it("goes through the usual preview and confirmation, and only the confirmation changes the plan", async () => {
    const plan = bridge({ status: "paid", tier: "starter", usage: STARTER });
    await open(plan);
    await press("Upgrade to Pro · $49/month");
    expect(plan.upgradePreview).toHaveBeenCalledExactlyOnceWith("pro", "app_usage");
    expect(plan.upgrade).not.toHaveBeenCalled();
    expect(dialog(), "the card steps aside for the confirmation").toBeNull();
    const confirm = document.querySelector('[role="alertdialog"]')!;
    expect(confirm.parentElement!.className).toContain("z-[80]");
    await press("Upgrade to Pro", confirm);
    expect(plan.upgrade).toHaveBeenCalledExactlyOnceWith("pro", "app_usage");
    expect(dialog()!.querySelector("h2")?.textContent).toBe("You're on Pro now. Your new allowances are ready.");
    expect(buttons()).toEqual(["Got it", "Close"]);
    await press("Got it");
    expect(botLimitShown()).toBe(false);
  });

  it("names what went wrong and stays open when the upgrade is refused", async () => {
    const plan = bridge({ status: "paid", tier: "starter", usage: STARTER });
    plan.upgradePreview.mockResolvedValue({ outcome: "refused", code: "rate_limited" } as never);
    await open(plan);
    await press("Upgrade to Pro · $49/month");
    expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull();
    expect(botLimitShown()).toBe(true);
  });

  it("says the upgrade is going through in the minute before this Cloud hears of it", async () => {
    await open(bridge({ status: "paid", tier: "pro", usage: { ...STARTER, tier: "pro", upgrades: [{ tier: "max", amount: 9900 }] } }));
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Your upgrade is going through. This can take a minute.");
    expect(buttons()).toEqual(["Got it", "Close"]);
  });

  it("a template too big for the room left says so, and doesn't claim the limit is reached", async () => {
    fixture.state = { config: { cloudHome: true, botLimit: 5 }, bots: made(4) };
    await open(bridge({ status: "paid", tier: "starter", usage: STARTER }));
    expect(dialog()!.querySelector("h2")?.textContent).toBe("That's more bots than Starter has room for");
  });

  it("in a browser tab, with no bridge, opens the Plan page", async () => {
    await open();
    expect(dialog()!.querySelector("p")?.textContent).toBe("To create more, upgrade this Cloud on its Plan page. Every bot you have stays as it is.");
    expect(buttons()).toEqual(["Open the Plan page", "Not now", "Close"]);
    await press("Open the Plan page");
    expect(openExternalLink).toHaveBeenCalledExactlyOnceWith("https://cloud.openmausbot.com/cloud");
  });

  it("on a person's other Cloud, which only reads its plan, opens its Plan page and closes", async () => {
    const plan = bridge({ status: "paid", tier: "starter" });
    await open(plan);
    expect(buttons()).toEqual(["Open the Plan page", "Not now", "Close"]);
    await press("Open the Plan page");
    expect(plan.manage).toHaveBeenCalledOnce();
    expect(botLimitShown()).toBe(false);
  });

  it.each([["Not now"], ["Close"]])("%s closes it, and the next press opens it again", async (label) => {
    await open(bridge({ status: "paid", tier: "starter", usage: STARTER }));
    await press(label);
    expect(dialog()).toBeNull();
    await act(async () => { showBotLimit(); });
    expect(dialog()).not.toBeNull();
  });

  it("Escape closes it, and Tab stays inside", async () => {
    await open(bridge({ status: "paid", tier: "starter", usage: STARTER }));
    await key("Tab");
    expect(document.activeElement?.textContent).toBe("Not now");
    await key("Tab", { shiftKey: true });
    await key("Tab", { shiftKey: true });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await key("Escape");
    expect(botLimitShown()).toBe(false);
  });

  it("leaves Escape to the confirmation while it is open", async () => {
    await open(bridge({ status: "paid", tier: "starter", usage: STARTER }));
    await press("Upgrade to Pro · $49/month");
    await key("Escape");
    expect(botLimitShown()).toBe(true);
    expect(dialog(), "back to the card").not.toBeNull();
  });
});

describe("the popup for Starter's other limits", () => {
  it("says Starter runs two tasks at once when work handed out was refused, with the upgrade", async () => {
    fixture.state = { config: { cloudHome: true, botLimit: 5, planTurns: { running: 2, waiting: 4 } }, bots: made(3) };
    await open(bridge({ status: "paid", tier: "starter", usage: STARTER }), "tasks");
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Starter runs 2 tasks at once");
    expect(dialog()!.querySelector("p")?.textContent).toContain("Upgrade to run more at once");
    expect(buttons()).toContain("Upgrade to Pro · $49/month");
  });

  it("opens by itself when a config frame says work was just refused, and not for a refusal from before", async () => {
    fixture.state = { config: { cloudHome: true, botLimit: 5, planTurns: { running: 2, waiting: 4, refusedAt: 1, refused: "tasks" } }, bots: made(3) };
    await act(async () => { root.render(createElement(BotLimitPopup)); });
    expect(dialog()).toBeNull();
    fixture.state = { config: { cloudHome: true, botLimit: 5, planTurns: { running: 2, waiting: 4, refusedAt: 2, refused: "tasks" } }, bots: made(3) };
    await act(async () => { root.render(createElement(BotLimitPopup)); });
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Starter runs 2 tasks at once");
  });

  it("lets the person choose which five stay awake, and saves exactly five", async () => {
    posted.length = 0;
    fixture.state = { config: { cloudHome: true, botLimit: 5, awakeLimit: 5, pausedBots: ["b5", "b6"] }, bots: made(7).map((bot) => ({ ...bot, name: bot.id })) };
    await open(bridge({ status: "paid", tier: "starter", usage: STARTER }), "paused");
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Starter keeps 5 bots awake");
    const picker = dialog()!.querySelector("[data-awake-bots]")!;
    expect(picker.textContent).toContain("5 of 5 chosen");
    const row = (id: string) => [...picker.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find((node) => node.textContent?.includes(id))!;
    expect([row("b5").disabled, row("b0").getAttribute("aria-checked")]).toEqual([true, "true"]);
    await act(async () => { row("b0").click(); });
    await act(async () => { row("b5").click(); });
    await press("Keep these awake", picker);
    expect(posted).toEqual([{ path: "/api/starter/awake", body: { awake: ["b1", "b2", "b3", "b4", "b5"] } }]);
    expect(botLimitShown()).toBe(false);
  });

  it("says a bot just made is paused, and swaps it in for the least recently used idle bot with one tap", async () => {
    posted.length = 0;
    const bots = made(6).map((bot, n) => ({ ...bot, name: n === 5 ? "Scout" : bot.id, tasks: [{ updatedAt: n === 1 ? 1 : 100 + n }], ...(n === 0 ? { busy: true } : {}) }));
    // A server that makes any number of bots sends no botLimit.
    fixture.state = { config: { cloudHome: true, awakeLimit: 5, pausedBots: ["b5"] }, bots };
    (window as unknown as { ogb?: unknown }).ogb = { cloudPlan: bridge({ status: "paid", tier: "starter", usage: STARTER }) };
    await act(async () => { root.render(createElement(BotLimitPopup)); });
    await act(async () => { showCreatedPaused("b5"); });
    await act(async () => {});
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Created Scout, paused for now");
    expect(dialog()!.textContent).toContain("Starter keeps 5 bots awake, so this one is paused. Choose which 5 stay awake, or upgrade to wake them all.");
    expect(dialog()!.textContent).not.toContain("You've reached");
    const picker = dialog()!.querySelector("[data-awake-bots]")!;
    await press("Keep these awake", picker);
    expect(posted).toEqual([{ path: "/api/starter/awake", body: { awake: ["b0", "b2", "b3", "b4", "b5"] } }]);
    expect(botLimitShown()).toBe(false);
  });
});

describe("the bots first offered awake", () => {
  const bot = (id: string, at: number, busy = false) => ({ id, busy, tasks: [{ updatedAt: at }] as never });
  it("keeps the awake ones as they are when nothing new is swapped in", () => {
    expect(initialAwake([bot("a", 1), bot("b", 2), bot("c", 3)], new Set(["c"]), 2)).toEqual(new Set(["a", "b"]));
  });

  it("swaps a new bot in for the least recently active one that isn't working, even before the paused list arrives", () => {
    const bots = [bot("new", 9), bot("a", 1, true), bot("b", 2), bot("c", 3), bot("d", 4), bot("e", 5)];
    expect(initialAwake(bots, new Set(["new"]), 5, "new")).toEqual(new Set(["new", "a", "c", "d", "e"]));
    expect(initialAwake(bots, new Set(), 5, "new")).toEqual(new Set(["new", "a", "c", "d", "e"]));
  });
});
