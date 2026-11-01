// @vitest-environment happy-dom
import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge, CloudRenewalResult } from "../../electron/cloud-account.mjs";
import type { CloudRenewal } from "../../electron/cloud-list.mjs";
import { setLocale } from "@/lib/i18n";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" } }, ready: true }) }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { bots: [], config: {} }, dispatch: vi.fn() }) }));
import { CLOUD_CALL_URL, CloudCancelPlan, type CloudRenewalActions } from "./CloudCancelPlan";
import { CloudAccountSettings, CloudPlanOnCloud } from "./CloudAccountSettings";

const NOW = Date.UTC(2026, 9, 28, 12), DAY = 86_400_000, END = NOW + 5 * DAY;
const day = (value: number) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
const trial: CloudRenewal = { trial: true, cancelled: false, renewsAt: END, endsAt: null, keptDays: 3 };
const cancelledTrial: CloudRenewal = { ...trial, cancelled: true, renewsAt: null, endsAt: END };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const show = async (element: ReactElement) => { await act(async () => { root.render(element); }); await settle(); };
const sheet = () => document.querySelector<HTMLElement>("[role='dialog']");
const text = () => document.body.textContent ?? "";
const button = (label: string, within: ParentNode = document.body) => [...within.querySelectorAll("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label);
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); await settle(); };
const write = async (label: string, value: string) => {
  const box = [...document.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value); box.dispatchEvent(new Event("input", { bubbles: true })); });
};
const chips = () => [...sheet()!.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].map(chip => [chip.textContent, chip.getAttribute("aria-pressed")]);
/** What main answers: a cancel that turns renewal off (when it ends from the Admin), a keep, or as told. */
function actionsFor(results: Partial<{ cancel: CloudRenewalResult; keep: CloudRenewalResult }> = {}) {
  const state = { status: "connected" } as CloudAccountState;
  return {
    cancel: vi.fn(async () => results.cancel ?? { outcome: "cancelled" as const, renewal: cancelledTrial, surveyed: true, state }),
    keep: vi.fn(async () => results.keep ?? { outcome: "kept" as const, state }),
  } satisfies CloudRenewalActions;
}

describe("the cancel sheet", () => {
  it("Cancel trial opens a calm sheet; the reason and both boxes go to main, then when it ends, that nothing is charged, how long its files stay, and Keep my plan", async () => {
    const actions = actionsFor(), changed = vi.fn();
    await show(createElement(CloudCancelPlan, { renewal: trial, actions, onChanged: changed }));
    expect(button("Cancel plan")).toBeUndefined();
    await click(button("Cancel trial"));
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    expect(sheet()!.querySelector("h2")?.textContent).toBe("Cancel your trial");
    expect(text()).toContain(`Your trial runs until ${day(END)}. Cancel now and nothing is charged.`);
    expect(sheet()!.querySelector("legend")?.textContent).toBe("Before you go: what's the main reason?");
    expect(chips()).toEqual([["Missing a feature", "false"], ["Too expensive", "false"], ["Hard to set up", "false"], ["Didn't work as I expected", "false"],
      ["Not using it right now", "false"], ["Something else", "false"]]);
    expect(document.activeElement?.textContent).toBe("Missing a feature");
    expect([...sheet()!.querySelectorAll("label")].map(label => label.textContent)).toEqual(["What did you expect MausBot to do? (optional)", "What could we have done better? (optional)"]);
    const call = sheet()!.querySelector<HTMLAnchorElement>(`a[href="${CLOUD_CALL_URL}"]`)!;
    expect([call.textContent, call.getAttribute("target"), call.parentElement!.textContent]).toEqual(["Book 30 minutes with Milind", "_blank", "Rather talk it through? Book 30 minutes with Milind"]);
    // One tap picks a reason; the same tap again lets it go.
    await click(button("Too expensive"));
    await click(button("Too expensive"));
    await click(button("Hard to set up"));
    expect(chips().filter(([, pressed]) => pressed === "true")).toEqual([["Hard to set up", "true"]]);
    await write("What did you expect", "To answer my email by itself.");
    await click(button("Cancel my trial"));
    expect(actions.cancel).toHaveBeenCalledExactlyOnceWith({ answer: "setup", expected: "To answer my email by itself." });
    expect(sheet()!.querySelector("[role='status']")?.textContent).toBe(`Cancelled. Your trial ends on ${day(END)}, and nothing is charged.`);
    expect(text()).toContain("The Cloud stops then. Its files are kept 3 days, then deleted.");
    expect(text()).toContain("Thanks. Milind and Omkar read every answer, and we'll write back if it's something we can build.");
    expect(changed).not.toHaveBeenCalled();
    // Changed your mind? Keep my plan: renewal back on, the sheet closes and the plan is read again.
    expect(text()).toContain("Changed your mind?");
    await click(button("Keep my plan", sheet()!));
    expect(actions.keep).toHaveBeenCalledOnce();
    expect(sheet()).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("cancelling never needs an answer: nothing said sends no survey; words without a reason go as they are; a failure says so and can be tried again", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: trial, actions }));
    await click(button("Cancel trial"));
    await click(button("Cancel my trial"));
    expect(actions.cancel).toHaveBeenLastCalledWith(null);
    await click(button("Done"));
    await click(button("Cancel trial"));
    await write("What could we have done better", "Tell me sooner what it needs.");
    await click(button("Cancel my trial"));
    expect(actions.cancel).toHaveBeenLastCalledWith({ answer: null, improve: "Tell me sooner what it needs." });
    await click(button("Done"));
    const failing = actionsFor({ cancel: { outcome: "failed", state: { status: "connected" } } });
    await show(createElement(CloudCancelPlan, { renewal: trial, actions: failing }));
    await click(button("Cancel trial"));
    await click(button("Not using it right now"));
    await click(button("Cancel my trial"));
    expect(sheet()!.querySelector("[role='alert']")?.textContent).toBe("That didn't go through, and nothing changed. Try again in a minute.");
    expect(sheet()!.getAttribute("data-cloud-cancel-sheet")).toBe("ask");
    expect(chips().find(([label]) => label === "Not using it right now")?.[1]).toBe("true");
    failing.cancel.mockRejectedValueOnce(new Error("main went away"));
    await click(button("Cancel my trial"));
    expect(sheet()!.querySelector("[role='alert']")).toBeTruthy();
    expect(failing.cancel).toHaveBeenCalledTimes(2);
  });

  it("Keep my plan before cancelling only closes the sheet; an Admin without Cancel says the Cloud page's Billing opened", async () => {
    const actions = actionsFor({ cancel: { outcome: "browser" } }), changed = vi.fn();
    await show(createElement(CloudCancelPlan, { renewal: trial, actions, onChanged: changed }));
    await click(button("Cancel trial"));
    await click(button("Keep my plan", sheet()!));
    expect([sheet(), actions.cancel.mock.calls.length, actions.keep.mock.calls.length, changed.mock.calls.length]).toEqual([null, 0, 0, 0]);
    await click(button("Cancel trial"));
    await click(button("Cancel my trial"));
    expect(sheet()!.querySelector("[role='status']")?.textContent).toBe("The Cloud page's Billing opened in your browser. You can do it there.");
    await click(button("Done"));
    expect([sheet(), changed.mock.calls.length]).toEqual([null, 0]);
  });

  it("a paid plan says Cancel plan and that nothing more is charged; a team's Cloud stops for everyone in it; files kept in days, a day, hours, or not at all", async () => {
    const paid: CloudRenewal = { trial: false, cancelled: false, renewsAt: END, endsAt: null, keptDays: 1, team: "Acme" };
    const actions = actionsFor({ cancel: { outcome: "cancelled", renewal: { ...paid, cancelled: true, renewsAt: null, endsAt: END }, surveyed: false, state: { status: "connected" } } });
    await show(createElement(CloudCancelPlan, { renewal: paid, actions }));
    expect(button("Cancel trial")).toBeUndefined();
    await click(button("Cancel plan"));
    expect(sheet()!.querySelector("h2")?.textContent).toBe("Cancel your plan");
    expect(text()).toContain(`Your plan runs until ${day(END)}. Cancel now and you won't be charged again. Acme's Cloud stops then, for everyone in the team.`);
    await click(button("Cancel my plan"));
    expect(sheet()!.querySelector("[role='status']")?.textContent).toBe(`Cancelled. Your plan ends on ${day(END)}. You won't be charged again.`);
    expect(text()).toContain("Acme's Cloud stops then, for everyone in the team. Its files are kept 1 day, then deleted.");
    expect(text()).not.toContain("Thanks.");
    const { stopsLine, endedLine } = await import("./CloudCancelPlan");
    expect(stopsLine({ ...paid, team: undefined, keptDays: 0.5 })).toBe("The Cloud stops then. Its files are kept 12 hours, then deleted.");
    expect(stopsLine({ ...paid, team: undefined, keptDays: 0 })).toBe("The Cloud stops then. Its files are deleted when it stops.");
    expect(stopsLine({ ...paid, team: undefined, keptDays: null })).toBe("The Cloud stops then.");
    expect(endedLine({ ...paid, cancelled: true, renewsAt: null, endsAt: null })).toBe("Cancelled. Your plan ends with the period you paid for. You won't be charged again.");
  });

  it("already cancelled: when it ends and Keep my plan, never Cancel; nothing at all without a renewal (someone else pays) or a way to change it", async () => {
    const actions = actionsFor(), changed = vi.fn();
    await show(createElement(CloudCancelPlan, { renewal: cancelledTrial, actions, onChanged: changed }));
    expect(container.querySelector("[data-cloud-cancel]")?.getAttribute("data-cloud-cancel")).toBe("cancelled");
    expect(container.querySelector("[role='status']")?.textContent).toBe(`Cancelled. Your trial ends on ${day(END)}, and nothing is charged.`);
    expect(button("Cancel trial")).toBeUndefined();
    await click(button("Keep my plan"));
    expect([actions.keep.mock.calls.length, changed.mock.calls.length]).toEqual([1, 1]);
    actions.keep.mockResolvedValueOnce({ outcome: "browser" });
    await click(button("Keep my plan"));
    expect(container.textContent).toContain("The Cloud page's Billing opened in your browser.");
    await show(createElement(CloudCancelPlan, { renewal: undefined, actions }));
    expect(container.innerHTML).toBe("");
    await show(createElement(CloudCancelPlan, { renewal: trial, actions: null }));
    expect(container.innerHTML).toBe("");
  });

  it("keeps its sheet open while main's state changes underneath (the plan cancelled), and Escape closes it", async () => {
    const actions = actionsFor();
    await show(createElement(CloudCancelPlan, { renewal: trial, actions }));
    await click(button("Cancel trial"));
    await click(button("Cancel my trial"));
    await show(createElement(CloudCancelPlan, { renewal: cancelledTrial, actions }));
    expect(sheet()!.getAttribute("data-cloud-cancel-sheet")).toBe("done");
    await act(async () => { sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    expect(sheet()).toBeNull();
  });
});

describe("the plan cards", () => {
  const paidState = (renewal?: CloudRenewal): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
    entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, verifiedAt: NOW, verifiedUntil: NOW + DAY, ...(renewal ? { renewal } : {}) });
  function accountBridge(state: CloudAccountState): CloudAccountBridge {
    return { state: vi.fn(async () => state), begin: vi.fn(), signInAgain: vi.fn(), reopen: vi.fn(), cancel: vi.fn(), refresh: vi.fn(async () => state), signOut: vi.fn(),
      openDashboard: vi.fn(async () => state), connectHome: vi.fn(), connectHomeForPhone: vi.fn(), onState: vi.fn(() => () => {}),
      cancelPlan: vi.fn(async () => ({ outcome: "browser" as const })), keepPlan: vi.fn(async () => ({ outcome: "kept" as const, state })) } as unknown as CloudAccountBridge;
  }

  it("this computer's Settings: Cancel trial for the account that pays, through main's own bridge; nothing for anyone else", async () => {
    const bridge = accountBridge(paidState(trial));
    vi.stubGlobal("window", Object.assign(window, { ogb: { cloudAccount: bridge } }));
    await show(createElement(CloudAccountSettings));
    expect(text()).toContain("Pro active · verified by MausBot Cloud");
    expect(button("Manage Cloud subscription")).toBeTruthy();
    await click(button("Cancel trial"));
    await click(button("Missing a feature"));
    await click(button("Cancel my trial"));
    expect(bridge.cancelPlan).toHaveBeenCalledExactlyOnceWith({ answer: "feature" });
    expect(text()).toContain("The Cloud page's Billing opened in your browser.");
    await act(async () => root.unmount()); root = createRoot(container);
    vi.stubGlobal("window", Object.assign(window, { ogb: { cloudAccount: accountBridge(paidState()) } }));
    await show(createElement(CloudAccountSettings));
    expect(text()).toContain("Pro active · verified by MausBot Cloud");
    expect(button("Cancel trial")).toBeUndefined();
    expect(button("Cancel plan")).toBeUndefined();
    // Cancelled during the trial: Keep my plan is the way back, so the trial's own button doesn't offer a second one.
    const ending = { ...paidState(cancelledTrial), trial: { state: "ending" as const, tier: "pro", endsAt: END, amount: 4900, chargeAt: null, holdUntil: null, deleteAt: END + 3 * DAY, keep: "portal" as const } };
    await act(async () => root.unmount()); root = createRoot(container);
    vi.stubGlobal("window", Object.assign(window, { ogb: { cloudAccount: accountBridge(ending) } }));
    await show(createElement(CloudAccountSettings));
    expect(button("Keep my plan")).toBeTruthy();
    expect(button("Subscribe to keep it")).toBeUndefined();
    expect(button("Manage Cloud subscription")).toBeTruthy();
  });

  it("the Cloud page in home mode: Cancel trial beside Manage in your browser, and the plan read again after; none without a renewal", async () => {
    let snapshot = { status: "paid" as const, tier: "pro", home: true as const, renewal: trial };
    const plan: CloudPlanBridge = { state: vi.fn(async () => snapshot), manage: vi.fn(async () => undefined),
      cancel: vi.fn(async () => { snapshot = { ...snapshot, renewal: cancelledTrial }; return { outcome: "cancelled" as const, renewal: cancelledTrial, surveyed: false, state: { status: "connected" as const } }; }),
      keep: vi.fn(async () => ({ outcome: "kept" as const, state: { status: "connected" as const } })) };
    await show(createElement(CloudPlanOnCloud, { bridge: plan }));
    expect(button("Manage in your browser")).toBeTruthy();
    await click(button("Cancel trial"));
    await click(button("Cancel my trial"));
    expect(plan.cancel).toHaveBeenCalledExactlyOnceWith(null);
    await click(button("Done"));
    expect(plan.state).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-cloud-cancel]")?.getAttribute("data-cloud-cancel")).toBe("cancelled");
    expect(button("Keep my plan")).toBeTruthy();
    snapshot = { status: "paid", tier: "pro", home: true, renewal: undefined as unknown as CloudRenewal };
    await act(async () => root.unmount()); root = createRoot(container);
    await show(createElement(CloudPlanOnCloud, { bridge: plan }));
    expect(button("Manage in your browser")).toBeTruthy();
    expect(container.querySelector("[data-cloud-cancel]")).toBeNull();
  });
});
