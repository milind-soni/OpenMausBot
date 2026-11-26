// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PlacesTogetherState } from "@/lib/places-together";
import { resetPlacesTogetherForTest } from "@/lib/places-together";
import { TogetherNotice } from "./TogetherNotice";

let container: HTMLDivElement, root: Root, said: PlacesTogetherState, changed: () => void, lent: boolean;
const state = (over: Partial<PlacesTogetherState> = {}): PlacesTogetherState => ({ v: 1, available: true, on: true, here: "computer",
  other: { home: "cloud", state: "ready", bots: [] }, notice: true, commands: lent, ...over });
const page = {
  state: vi.fn(async () => ({ ...said, commands: lent })),
  set: vi.fn(async (on: boolean) => { said = on ? state({ notice: undefined }) : state({ on: false, other: null, notice: undefined }); return said; }),
  open: vi.fn(async () => true),
  onChanged: vi.fn((cb: () => void) => { changed = cb; return () => {}; }),
  noticeShown: vi.fn(async () => true),
  noticeDone: vi.fn(async () => {}),
  setCommands: vi.fn(async (on: boolean) => { lent = on; return on; }),
};
const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const onClose = vi.fn();
const render = async () => { await act(async () => root.render(createElement(TogetherNotice, { onClose }))); await act(async () => {}); };
const click = async (selector: string) => { await act(async () => { q(selector)!.click(); }); await act(async () => {}); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  lent = false;
  said = state();
  window.ogb = { placesTogether: page } as never;
  for (const fn of Object.values(page)) fn.mockClear();
  onClose.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetPlacesTogetherForTest(); vi.unstubAllGlobals(); delete (window as { ogb?: unknown }).ogb; });

it("drawn, it tells main once (which turns the default on) and takes no focus: the person keeps typing", async () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  await render();
  expect(page.noticeShown).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(input);
  expect(q("[data-notice='together-default']")?.tagName).toBe("ASIDE");
  expect(q("[role='dialog'], [aria-modal]")).toBeNull();
  await act(async () => changed());
  expect(page.noticeShown).toHaveBeenCalledTimes(1);
  expect(q("[data-notice='together-default']")!.textContent).toContain("one list");
  expect(q("[data-together-notice-list]")!.getAttribute("aria-checked")).toBe("true");
  expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked")).toBe("false");
  expect(page.noticeDone).not.toHaveBeenCalled();
  input.remove();
});

it("its first switch turns the joining off at once, without lending anything, and ends the notice for good while it stays up", async () => {
  await render();
  await click("[data-together-notice-list]");
  expect(page.set).toHaveBeenCalledWith(false, "notice");
  expect(page.noticeDone).toHaveBeenCalledTimes(1);
  expect(page.setCommands).not.toHaveBeenCalled();
  expect(q("[data-together-notice-list]")!.getAttribute("aria-checked")).toBe("false");
  expect(q("[data-together-notice-commands]")).toBeNull();
  expect(q("[data-together-notice-off]")).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await click("[data-together-notice-list]");
  expect(page.set).toHaveBeenLastCalledWith(true, "notice");
});

it("its second switch is running commands, as lending says it: off unless they had it on, turned only by them, and live while the notice is up", async () => {
  await render();
  expect(q("[data-notice='together-default']")!.textContent).toContain("Let your Clouds' bots run commands on this computer");
  await click("[data-together-notice-commands]");
  expect(page.setCommands).toHaveBeenCalledWith(true);
  expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked")).toBe("true");
  expect(page.noticeDone).toHaveBeenCalled();
  lent = false;
  await act(async () => changed());
  await act(async () => {});
  expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked"), "turned off from the icon's menu meanwhile: the switch follows lending").toBe("false");
  page.setCommands.mockImplementationOnce(async () => false);
  await click("[data-together-notice-commands]");
  expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked"), "Cancel in the icon's question: lending still says off").toBe("false");
  await act(async () => root.unmount());
  resetPlacesTogetherForTest();
  root = createRoot(container);
  lent = true;
  said = state();
  await render();
  expect(q("[data-together-notice-commands]")!.getAttribute("aria-checked")).toBe("true");
});

it("Got it, the close button and Escape each close it for good", async () => {
  await render();
  await click("[data-together-notice-done]");
  expect([page.noticeDone.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 1]);
  await click("[data-notice='together-default'] button[aria-label]");
  expect([page.noticeDone.mock.calls.length, onClose.mock.calls.length]).toEqual([2, 2]);
  await act(async () => { q("[data-notice='together-default']")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect([page.noticeDone.mock.calls.length, onClose.mock.calls.length]).toEqual([3, 3]);
});

it("while main is still turning the default on, the list switch already reads on", async () => {
  said = state({ on: false, other: null });
  page.noticeShown.mockImplementationOnce(() => new Promise(() => {}));
  await render();
  expect(q("[data-together-notice-list]")!.getAttribute("aria-checked")).toBe("true");
});

it("for a person whose home is My Cloud, one more line says this computer's bots and their routines now run while the app is open; for others, none", async () => {
  await render();
  expect(q("[data-together-notice-background]")).toBeNull();
  await act(async () => root.unmount());
  resetPlacesTogetherForTest();
  root = createRoot(container);
  said = state({ profileHome: true });
  await render();
  expect(q("[data-together-notice-background]")!.textContent).toBe("This computer's bots and their routines now run while the app is open.");
});
