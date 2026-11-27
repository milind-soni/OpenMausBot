// @vitest-environment happy-dom
// What's new's slide for "This computer and My Cloud together": the corner notice's choice inside the carousel, writing
// exactly what the notice writes, with the carousel's keyboard as it was.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { resetPlacesTogetherForTest, type PlacesTogetherState } from "@/lib/places-together";
import type { WhatsNewAction, WhatsNewSlide, WhatsNewView } from "@/lib/whats-new";
import { TogetherNotice } from "../TogetherNotice";
import { WhatsNewPopup } from "./WhatsNewPopup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const VIEW: WhatsNewView = { slides: ["cloudNews", "teamNews", "together"], audience: "own", signedIn: true, staging: false, plans: {} };

let host: HTMLDivElement, root: Root, said: PlacesTogetherState, lent: boolean, steps: Array<[WhatsNewAction, WhatsNewSlide]>;
const state = (over: Partial<PlacesTogetherState> = {}): PlacesTogetherState => ({ v: 1, available: true, on: true, here: "computer",
  other: { home: "cloud", state: "ready", bots: [] }, notice: true, commands: lent, ...over });
const page = {
  state: vi.fn(async () => ({ ...said, commands: lent })),
  set: vi.fn(async (on: boolean) => { said = on ? state({ notice: undefined }) : state({ on: false, other: null, notice: undefined }); return said; }),
  open: vi.fn(async () => true),
  onChanged: vi.fn(() => () => {}),
  noticeShown: vi.fn(async () => true),
  noticeDone: vi.fn(async () => {}),
  setCommands: vi.fn(async (on: boolean) => { lent = on; return on; }),
};
const props = { report: vi.fn((action: WhatsNewAction, slide: WhatsNewSlide) => void steps.push([action, slide])), onBuy: vi.fn(), onOpenApps: vi.fn(), onDone: vi.fn() };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const show = async (view: WhatsNewView = VIEW) => { await act(async () => { root.render(createElement(WhatsNewPopup, { view, ...props })); }); await flush(); };
const q = (selector: string) => host.querySelector<HTMLElement>(`[data-whats-new-slide]:not([inert]) ${selector}`);
const click = async (selector: string) => { await act(async () => { q(selector)!.click(); }); await flush(); };
const key = async (name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return event;
};
/** The carousel opened, then walked to its last slide, the notice's. */
const showTogether = async () => { await show(); await key("ArrowRight"); await key("ArrowRight"); await flush(); };
const focused = () => document.activeElement!.getAttribute("aria-labelledby") || (document.activeElement as HTMLElement).textContent || document.activeElement!.getAttribute("aria-label");
/** What the bridge was asked, in order: the same calls from the slide as from the corner notice. */
const writes = () => [
  ...page.set.mock.calls.map(call => ["set", ...call]),
  ...page.setCommands.mock.calls.map(call => ["setCommands", ...call]),
  ...(page.noticeDone.mock.calls.length ? [["noticeDone"]] : []),
];

beforeEach(() => {
  setLocale("en"); vi.clearAllMocks(); steps = []; lent = false; said = state();
  (window as { ogb?: unknown }).ogb = { placesTogether: page, openExternal: vi.fn(async () => true) };
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); resetPlacesTogetherForTest(); delete (window as { ogb?: unknown }).ogb;
});

describe("What's new's together slide", () => {
  it("comes last, with the notice's words and its two switches: the list on, commands off as lending says, and no buy button", async () => {
    await show();
    expect(host.querySelector("[data-whats-new]")!.getAttribute("data-whats-new")).toBe("cloudNews");
    expect(steps, "opened on the first slide: the notice's is not seen").toEqual([["seen", "cloudNews"]]);
    await key("ArrowRight"); await key("ArrowRight"); await flush();
    expect(host.querySelector("[data-whats-new]")!.getAttribute("data-whats-new")).toBe("together");
    expect(q("h2")!.textContent).toBe("Your bots are in one list now");
    expect(q("[data-together-notice-list]")!.getAttribute("aria-checked")).toBe("true");
    expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector("[data-whats-new-slide='together']")!.textContent).toContain("work a Cloud bot hands to a bot here runs without commands");
    expect(q("[data-whats-new-got-it]")!.textContent, "the last slide, which only tells: Got it").toBe("Got it");
    expect(page.noticeShown, "the carousel tells main when it is seen, not the slide on its own").not.toHaveBeenCalled();
    expect(steps).toEqual([["seen", "cloudNews"], ["next", "cloudNews"], ["seen", "teamNews"], ["next", "teamNews"], ["seen", "together"]]);
  });

  it("the switches write the same state as the corner notice's: the list off, then back on, and commands on through main's own question", async () => {
    await showTogether();
    await click("[data-together-notice-list]");
    expect(q("[data-together-notice-off]")!.textContent).toContain("show apart again");
    expect(q("[data-together-notice-commands]")).toBeNull();
    await click("[data-together-notice-list]");
    await click("[data-together-notice-commands]");
    expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("[data-whats-new-slide='together']")!.textContent).toContain("can run any command on this computer as you");
    const fromSlide = writes();
    expect(fromSlide).toEqual([["set", false, "notice"], ["set", true, "notice"], ["setCommands", true], ["noticeDone"]]);
    expect(props.onDone, "a switch never ends the carousel").not.toHaveBeenCalled();

    await act(async () => root.unmount());
    resetPlacesTogetherForTest(); vi.clearAllMocks(); lent = false; said = state();
    root = createRoot(host);
    await act(async () => { root.render(createElement(TogetherNotice, { onClose: () => {} })); }); await flush();
    for (const selector of ["[data-together-notice-list]", "[data-together-notice-list]", "[data-together-notice-commands]"]) {
      await act(async () => { host.querySelector<HTMLElement>(selector)!.click(); }); await flush();
    }
    expect(writes(), "the corner notice, switched the same way").toEqual(fromSlide);
  });

  it("a failed switch says so on the slide and leaves the carousel up", async () => {
    page.setCommands.mockRejectedValueOnce(new Error("no"));
    await showTogether();
    await click("[data-together-notice-commands]");
    expect(q("[role='alert']")!.textContent).toBe("That couldn't be saved. Try again.");
    expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked")).toBe("false");
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it("keyboard as before: Tab reaches both switches and stays inside, the arrows move slides, Escape closes", async () => {
    await show();
    expect(q("h2")!.textContent).toBe("What's new in MausBot Cloud");
    expect(q("button.ui-button-primary"), "a slide that only tells has no buy button").toBeNull();
    await key("ArrowRight");
    expect(q("h2")!.textContent).toBe("What's new for your team");
    expect(q("[data-whats-new-got-it]"), "not the last slide: Next, not Got it").toBeNull();
    await key("ArrowRight");
    expect(host.querySelector("[data-whats-new]")!.getAttribute("data-whats-new")).toBe("together");
    const order: Array<string | null> = [];
    for (let i = 0; i < 4; i++) { expect((await key("Tab")).defaultPrevented).toBe(true); order.push(focused()); }
    expect(order, "no Not now on a slide that only tells").toEqual(["whats-new-together-list", "whats-new-together-commands", "Got it", "Slide 1 of 3"]);
    expect((await key("Escape")).defaultPrevented).toBe(true);
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(steps.at(-1)).toEqual(["close", "together"]);
  });

  it("alone, it ends with Got it, counted on its slide; before main has turned the default on it still shows the list on", async () => {
    said = state({ on: false, other: null });
    await show({ ...VIEW, slides: ["together"] });
    expect(q("[data-together-notice-list]")!.getAttribute("aria-checked"), "not drawn yet: shown on, as the slide's showing turns it on").toBe("true");
    await click("[data-whats-new-got-it]");
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(steps.at(-1)).toEqual(["got_it", "together"]);
  });
});
