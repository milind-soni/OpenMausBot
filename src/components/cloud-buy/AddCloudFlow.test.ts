// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLOUD_SWATCH_COLORS } from "../../../electron/cloud-list.mjs";
import type { AddCloudView } from "../../../electron/cloud-rail.mjs";
import { addCloudScreen, addCloudStop, SWATCH_COLOR, swatchFill } from "@/lib/cloud-extra";
import { setLocale } from "@/lib/i18n";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./CloudMascotScene", () => ({ CloudMascotScene: () => null }));
const { AddCloudFlow } = await import("./AddCloudFlow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = 1_800_000_000_000;
const OFFER = { recommended: "pro", plans: [{ tier: "starter", label: "Starter", amount: 1500 }, { tier: "pro", label: "Pro", amount: 4900 }] };
const base = (extra: Partial<Extract<AddCloudView, { signedIn: true }>> = {}): AddCloudView =>
  ({ signedIn: true, hasCloud: true, supported: true, canAdd: true, offer: OFFER, count: 1, home: { name: "My Cloud", color: null }, ...extra });
const adding = (status: "checkout" | "setting_up" | "ready" | "problem", extra = {}) => ({ name: "Client B", color: "rose" as const, tier: "pro", startedAt: NOW, status, link: true as const, ...extra });

it("each screen follows the Admin's word first: a Cloud being bought shows how it is going, until it was opened", () => {
  const at = (view: AddCloudView | null | undefined, ui = {}) => addCloudScreen(view, { now: NOW, ...ui }).kind;
  expect([at(undefined), at(null), at({ signedIn: false }), at(base({ hasCloud: false }))]).toEqual(["checking", "unreachable", "first", "first"]);
  expect(at(base({ supported: false, canAdd: false }))).toBe("stop");
  expect(addCloudScreen(base({ supported: false, canAdd: false }), { now: NOW })).toEqual({ kind: "stop", reason: "one", home: "My Cloud" });
  expect(addCloudScreen(base({ canAdd: false, blocked: "cap" }), { now: NOW })).toMatchObject({ reason: "one" });
  expect(addCloudScreen(base({ canAdd: false, blocked: "signups_closed" }), { now: NOW })).toMatchObject({ reason: "signups_closed" });
  expect(at(base())).toBe("choose");
  expect(addCloudScreen(base(), { now: NOW, tier: "pro" })).toMatchObject({ kind: "name", plan: { tier: "pro" } });
  expect(at(base(), { tier: "enterprise" })).toBe("choose");
  expect(at(base(), { failed: true })).toBe("error");
  expect(at(base({ offer: null }))).toBe("unreachable");
  expect(addCloudScreen(base({ adding: adding("checkout") }), { now: NOW + 31 * 60_000 })).toMatchObject({ kind: "waiting", late: true });
  expect([at(base({ adding: adding("checkout") })), at(base({ adding: adding("setting_up") })), at(base({ adding: adding("ready") })), at(base({ adding: adding("problem") }))])
    .toEqual(["waiting", "starting", "ready", "problem"]);
  expect(at(base({ adding: adding("ready", { done: true }) })), "opened: the purchase is over").toBe("choose");
  expect(["cap", "mystery", "rate", "checkout_open"].map(addCloudStop)).toEqual(["one", "one", "rate", "checkout_open"]);
});

it("every Admin swatch is drawn in the colour main saves for it", () => {
  expect(SWATCH_COLOR).toEqual(CLOUD_SWATCH_COLORS);
  expect(swatchFill("green")).toBe("var(--identity-teal)");
  expect(swatchFill("slate")).toBe("var(--color-raised)");
});

let host: HTMLDivElement, root: Root | null = null;
let view: AddCloudView;
const bridge = { state: vi.fn(async () => view), start: vi.fn(async () => ({ outcome: "opened" as const })), reopen: vi.fn(async () => true), copyLink: vi.fn(async () => true),
  open: vi.fn(async () => {}), interest: vi.fn(async () => {}), sheet: vi.fn(async () => {}) };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const buttonNamed = (name: string) => [...host.querySelectorAll("button")].find((button) => button.textContent?.trim().startsWith(name));
beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  view = base();
  Object.assign(window, { ogb: { cloudAdd: bridge, workspaces: { onChanged: () => () => {} } } });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });
async function mount(props: Partial<Parameters<typeof AddCloudFlow>[0]> = {}) {
  const done = { closed: 0, first: 0 };
  root = createRoot(host);
  await act(async () => { root!.render(createElement(AddCloudFlow, { onClose: () => { done.closed++; }, onFirstCloud: () => { done.first++; }, now: () => NOW, ...props })); });
  await flush();
  return done;
}

it("a plan, then its name and colour, then the Admin's checkout; the sheet then follows the payment, the setup and the ready Cloud", async () => {
  await mount();
  expect(host.querySelector("[data-cloud-add='offer']")).toBeTruthy();
  expect(host.textContent, "another Cloud has no free trial").not.toContain("Free for");
  await click(host.querySelector("[data-plan-buy='pro']"));
  expect(host.querySelector("[data-cloud-add='extra-name']")?.textContent).toContain("Name your new Cloud");
  expect((host.querySelector("input") as HTMLInputElement).placeholder).toBe("Cloud 2");
  await click(host.querySelector("[data-swatch='violet']"));
  expect(host.querySelector("[data-swatch='violet']")?.getAttribute("aria-checked")).toBe("true");
  bridge.start.mockImplementationOnce(async () => { view = base({ adding: adding("checkout") }); return { outcome: "opened" as const }; });
  await click(buttonNamed("Continue to checkout"));
  await flush();
  expect(bridge.start.mock.calls).toEqual([["pro", "Cloud 2", "violet"]]);
  expect(host.querySelector("[data-cloud-add='extra-waiting']")?.textContent).toContain("Waiting for your payment");
  await click(buttonNamed("Reopen checkout"));
  expect(bridge.reopen).toHaveBeenCalledTimes(1);
  view = base({ adding: adding("ready") });
  await click(buttonNamed("Copy link"));
  expect(bridge.copyLink).toHaveBeenCalledTimes(1);
});

it("another Cloud's checkout still open: the sheet follows that one, with its page to reopen, and sign-ups closed is said calmly", async () => {
  await mount();
  await click(host.querySelector("[data-plan-buy='pro']"));
  bridge.start.mockImplementationOnce(async () => { view = base({ adding: adding("checkout", { name: "Client B" }) }); return { outcome: "blocked", blocked: "checkout_open" } as never; });
  await click(buttonNamed("Continue to checkout"));
  await flush();
  expect(host.querySelector("[data-cloud-add='extra-waiting']")?.textContent).toContain("Waiting for your payment");
  await click(buttonNamed("Reopen checkout"));
  expect(bridge.reopen).toHaveBeenCalledTimes(1);
  await act(async () => root?.unmount()); root = null;
  view = base();
  bridge.start.mockResolvedValueOnce({ outcome: "blocked", blocked: "signups_closed" } as never);
  await mount();
  await click(host.querySelector("[data-plan-buy='pro']"));
  await click(buttonNamed("Continue to checkout"));
  expect(host.querySelector("[data-cloud-add='extra-signups_closed']")?.textContent).toContain("New Clouds can't be bought right now.");
});

it("the Cloud bought is ready: Open opens it and closes the sheet", async () => {
  view = base({ adding: adding("ready") });
  const done = await mount();
  expect(host.querySelector("[data-cloud-add='extra-ready']")?.textContent).toContain("Client B is ready");
  await click(buttonNamed("Open Client B"));
  expect(bridge.open).toHaveBeenCalledTimes(1);
  expect(done.closed).toBe(1);
});

it("the Admin refusing to add (its cap) is the calm one-Cloud word; no Cloud of their own yet is this computer's own sheet", async () => {
  bridge.start.mockResolvedValueOnce({ outcome: "blocked", blocked: "cap" } as never);
  await mount();
  await click(host.querySelector("[data-plan-buy='starter']"));
  await click(buttonNamed("Continue to checkout"));
  expect(host.querySelector("[data-cloud-add='extra-one']")?.textContent).toContain("One Cloud per account for now");
  await click(buttonNamed("Email me when I can add another"));
  expect(bridge.interest).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("We'll email you");
  await act(async () => root?.unmount()); root = null;
  view = base({ hasCloud: false });
  const done = await mount();
  expect(done.first).toBe(1);
});
