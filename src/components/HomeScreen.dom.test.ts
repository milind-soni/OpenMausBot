// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HomeBridge, HomeView } from "../../electron/home-window.mjs";
import { setLocale } from "@/lib/i18n";
import { HomeScreen } from "./HomeScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
function bridgeOf(view: HomeView, remove?: HomeBridge["remove"]) {
  return { state: vi.fn(async () => view), onState: vi.fn(() => () => {}), retry: vi.fn(async () => view), signIn: vi.fn(async () => {}), repair: vi.fn(async () => {}),
    ...(remove ? { remove } : {}) } satisfies HomeBridge;
}
async function mount(bridge: HomeBridge, manage?: () => Promise<void>) {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(HomeScreen, { bridge, ...(manage ? { manage } : {}) })); });
  await settle();
}
const click = async (selector: string) => { const element = host.querySelector<HTMLElement>(selector); expect(element, selector).toBeTruthy(); await act(async () => { element!.click(); }); await settle(); };
beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); Object.assign(window, { ogb: {} }); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

it("an ended Cloud: Buy again on the Cloud page, and Remove from list asked first in plain words; the Admin's no is said", async () => {
  const remove = vi.fn(async () => "refused" as const), manage = vi.fn(async () => {});
  await mount(bridgeOf({ screen: "ended", name: "My Cloud", deleteAt: Date.now() + 2 * 86_400_000, removable: true }, remove), manage);
  expect(host.querySelector("[data-home-screen]")?.getAttribute("data-home-screen")).toBe("ended");
  expect(host.querySelector("[role='status'] span"), "no spinner for a Cloud that isn't running").toBeNull();
  expect(host.querySelector("[data-home-action='buy']")?.textContent).toBe("Buy again");
  await click("[data-home-action='buy']");
  expect(manage).toHaveBeenCalledTimes(1);
  await click("[data-home-remove-ask]");
  expect(host.querySelector("[data-home-remove] [role='alertdialog'] p")?.textContent).toBe("Remove “My Cloud” from your list? You can buy a new Cloud any time.");
  expect(remove, "nothing removed before the person says yes").not.toHaveBeenCalled();
  await click("[data-home-remove-confirm]");
  expect(remove).toHaveBeenCalledTimes(1);
  expect(host.querySelector("[data-home-remove] [role='alert']")?.textContent).toBe("It can't be removed right now: it is running again, or still has a plan.");
});

it("Remove from list shows only where the Admin says so and the app can; a Cloud that didn't answer offers Try again", async () => {
  await mount(bridgeOf({ screen: "ended", name: "Old" }), async () => {});
  expect(host.querySelector("[data-home-remove]"), "not removable: no such choice").toBeNull();
  await act(async () => root?.unmount());
  await mount(bridgeOf({ screen: "ended", name: "Old", removable: true }), async () => {});
  expect(host.querySelector("[data-home-remove]"), "an older app without the channel: no such choice").toBeNull();
  await act(async () => root?.unmount());
  const offline = bridgeOf({ screen: "offline", name: "Acme" });
  await mount(offline);
  expect(host.querySelector("[role='status'] span"), "no spinner going on for ever").toBeNull();
  const retried = offline.retry.mock.calls.length;
  await click("[data-home-action='retry']");
  expect(host.querySelector("[data-home-action='retry']")?.textContent).toBe("Try again");
  expect(offline.retry.mock.calls.length).toBe(retried + 1);
});

it("a checkout that wasn't finished continues where this app keeps its page, else on the Cloud page", async () => {
  const reopen = vi.fn(async () => false), manage = vi.fn(async () => {});
  Object.assign(window, { ogb: { cloudAdd: { reopen } } });
  await mount(bridgeOf({ screen: "checkout", name: "Client B" }), manage);
  await click("[data-home-action='continue']");
  expect([reopen.mock.calls.length, manage.mock.calls.length]).toEqual([1, 1]);
  reopen.mockResolvedValue(true);
  await click("[data-home-action='continue']");
  expect([reopen.mock.calls.length, manage.mock.calls.length]).toEqual([2, 1]);
});
