// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { WhatsNewView } from "@/lib/whats-new";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: () => true }));
const { otherDialogOpen, useOtherDialogOpen } = await import("./notice-dialogs");
const { WhatsNewPopup } = await import("./whats-new/WhatsNewPopup");
const { Spotlight } = await import("./onboarding/Spotlight");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const VIEW: WhatsNewView = { slides: ["pro", "team"], audience: "none", signedIn: false, staging: false,
  plans: { pro: { name: "Pro", terms: "Pro · $49/month + tax" }, team: { name: "Team", terms: "Team · $169/month + tax" } } };
const done = vi.fn();
let roots: Root[];
const mount = async (element: ReturnType<typeof createElement>) => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => { root.render(element); });
};
const showPopup = () => mount(createElement(WhatsNewPopup, { view: VIEW, report: () => {}, onBuy: () => {}, onDone: done }));

beforeEach(() => { setLocale("en"); roots = []; done.mockClear(); });
afterEach(async () => { for (const root of roots) await act(async () => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); });

it("knows when another dialog is open, and notices it opening and closing", async () => {
  vi.useFakeTimers();
  const seen: boolean[] = [];
  const Probe = () => { seen.push(useOtherDialogOpen(true)); return null; };
  await showPopup();
  expect(otherDialogOpen(), "the popup itself is the queue's own").toBe(false);
  await mount(createElement(Probe));
  expect(seen.at(-1)).toBe(false);
  const other = document.body.appendChild(document.createElement("div"));
  other.setAttribute("aria-modal", "true");
  expect(otherDialogOpen()).toBe(true);
  await act(async () => { vi.advanceTimersByTime(1_000); });
  expect(seen.at(-1)).toBe(true);
  other.remove();
  await act(async () => { vi.advanceTimersByTime(1_000); });
  expect(seen.at(-1)).toBe(false);
});

it("any dialog on screen counts, modal or not, the tour's cards and the card that says a new Cloud is set up; one not shown or the queue's own does not", async () => {
  await showPopup();
  for (const [attribute, value] of [["role", "dialog"], ["role", "alertdialog"], ["aria-modal", "true"], ["data-tour-card", ""], ["data-cloud-setup-ready", ""]]) {
    const other = document.body.appendChild(document.createElement("div"));
    other.setAttribute(attribute!, value!);
    expect(otherDialogOpen(), `${attribute}=${value}`).toBe(true);
    other.style.display = "none";
    expect(otherDialogOpen(), `not shown: ${attribute}=${value}`).toBe(false);
    other.remove();
  }
  const inside = document.querySelector('[role="dialog"]')!.appendChild(document.createElement("div"));
  inside.setAttribute("role", "alertdialog");
  expect(otherDialogOpen(), "inside the popup").toBe(false);
  for (const own of ["data-simple-mode-prompt", "data-updates-consent-popup"]) {
    const popup = document.body.appendChild(document.createElement("div"));
    popup.setAttribute(own, ""); popup.setAttribute("role", "dialog");
    expect(otherDialogOpen(), own).toBe(false);
    popup.remove();
  }
});

it("the first conversation's spotlight is a dialog the popup waits for, and an Escape meant for the spotlight reaches it", async () => {
  const gotIt = vi.fn();
  await mount(createElement(Spotlight, { anchor: null, placement: "below", primary: { label: "Got it", onClick: gotIt }, onDone: gotIt, children: "Approve this step" }));
  expect(document.querySelector('[role="dialog"]')!.getAttribute("aria-modal"), "the spotlight is not modal").toBeNull();
  expect(otherDialogOpen()).toBe(true);
  const spotButton = [...document.querySelectorAll("button")].find(button => button.textContent === "Got it")!;
  await showPopup(); spotButton.focus();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { spotButton.dispatchEvent(escape); });
  expect(done).not.toHaveBeenCalled(); expect(escape.defaultPrevented).toBe(false);
  expect(gotIt).toHaveBeenCalledOnce();
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => { spotButton.dispatchEvent(tab); });
  expect(tab.defaultPrevented, "nor does it pull Tab out of the spotlight").toBe(false);
});

it("the calendar's Quick create (a dialog with only a label) counts too", () => {
  const quick = document.body.appendChild(document.createElement("div"));
  quick.setAttribute("role", "dialog"); quick.setAttribute("aria-label", "Quick create");
  quick.appendChild(document.createElement("input")).focus();
  expect(otherDialogOpen()).toBe(true);
  quick.remove();
  expect(otherDialogOpen()).toBe(false);
});
