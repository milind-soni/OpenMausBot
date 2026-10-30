// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChromeRailBridge, ChromeRailState } from "../../electron/chrome-rail.mjs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); vi.resetModules(); });

/** Main's side of the bridge: its answer to the page's offer, and to a click (refused when `refuse`). */
function bridge(answer: ChromeRailState | Error, { refuse = false } = {}) {
  let push: (state: ChromeRailState) => void = () => {};
  const rail = {
    state: vi.fn(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))),
    setHidden: vi.fn((hidden: boolean) => (refuse ? Promise.reject(new Error("Choose to hide or show your computers.")) : Promise.resolve({ available: true, hidden }))),
    onState: vi.fn((callback: (state: ChromeRailState) => void) => { push = callback; return () => {}; }),
  };
  return { rail, push: (state: ChromeRailState) => act(async () => push(state)) };
}

/** A fresh page with the sidebar's button and Settings' switch, as this window's bridge answers them. */
async function page(rail: ChromeRailBridge | undefined) {
  vi.resetModules();
  Object.assign(window, { ogb: rail ? { rail } : undefined });
  const { setLocale } = await import("@/lib/i18n");
  setLocale("en");
  const { ChromeRailRow, ChromeRailToggle } = await import("./ChromeRailToggle");
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement("div", null, createElement(ChromeRailToggle, { advanced: true, icons: false }),
      createElement("div", { "data-settings-look": "simple" }, createElement(ChromeRailRow))));
  });
  await act(async () => { await Promise.resolve(); });
}
const button = () => host.querySelector<HTMLButtonElement>("[data-rail-toggle]");
const toggle = () => host.querySelector<HTMLButtonElement>("[data-rail-switch] [role='switch']");
const said = () => [button()?.getAttribute("aria-label"), button()?.getAttribute("title"), button()?.getAttribute("aria-expanded"), toggle()?.getAttribute("aria-checked")];
const click = async (target: HTMLElement | null) => {
  expect(target).toBeTruthy();
  await act(async () => { target!.click(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

it("once main says this window has a rail, the button hides it and shows it again, and the switch in Settings says the same", async () => {
  const { rail } = bridge({ available: true, hidden: false });
  await page(rail);
  expect(rail.state, "one offer from the page, whatever asks").toHaveBeenCalledTimes(1);
  expect(said()).toEqual(["Hide your computers", "Hide your computers", "true", "true"]);
  const row = host.querySelector("[data-rail-switch]")!.textContent!;
  for (const words of ["Show your computers", "A circle for each place your bots live, at the window's left edge."]) expect(row).toContain(words);
  await click(button());
  expect(rail.setHidden).toHaveBeenLastCalledWith(true);
  expect(said()).toEqual(["Show your computers", "Show your computers", "false", "false"]);
  await click(toggle());
  expect(rail.setHidden).toHaveBeenLastCalledWith(false);
  expect(said()).toEqual(["Hide your computers", "Hide your computers", "true", "true"]);
});

it("main's word wins: a click it refuses puts the button back, and with one place left the button and the switch go", async () => {
  const { rail, push } = bridge({ available: true, hidden: false }, { refuse: true });
  await page(rail);
  await click(button());
  expect(rail.setHidden).toHaveBeenCalledWith(true);
  expect(said()).toEqual(["Hide your computers", "Hide your computers", "true", "true"]);
  await push({ available: false, hidden: false });
  expect([button(), toggle()]).toEqual([null, null]);
  await push({ available: true, hidden: true });
  expect(said()).toEqual(["Show your computers", "Show your computers", "false", "false"]);
});

it("nothing in a browser, on an older app, on a page that isn't beside the rail, or with one place", async () => {
  const older: ChromeRailBridge = { expand: async () => {}, onSkin: () => () => {} };
  const elsewhere = bridge(new Error("rail:offer is only available to the page beside the window's rail")).rail;
  const onePlace = bridge({ available: false, hidden: true }).rail;
  for (const rail of [undefined, older, elsewhere, onePlace]) {
    await page(rail);
    expect([button(), toggle()]).toEqual([null, null]);
    await act(async () => root?.unmount());
    root = null;
  }
});
