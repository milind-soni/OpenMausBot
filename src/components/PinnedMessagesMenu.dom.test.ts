// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { PinnedMessagesMenu, pinnedPreview } from "./PinnedMessagesMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; });

const message = (patch: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", text: "Ship on Friday", createdAt: 1, ...patch }) as Message;
const PINS = [{ id: "m1", sender: "Pepper", text: "Ship on Friday" }];

async function mount(props: Partial<Parameters<typeof PinnedMessagesMenu>[0]> = {}) {
  const onJump = vi.fn(), onUnpin = vi.fn();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(PinnedMessagesMenu, { pins: PINS, onJump, onUnpin, ...props })));
  return { root, onJump, onUnpin };
}
const trigger = () => document.querySelector<HTMLButtonElement>("[data-pinned-menu] > button");
const items = () => [...document.querySelectorAll<HTMLButtonElement>("[role=menu] [role=menuitem]")];
const key = (name: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });

it("shows no button while nothing is pinned", async () => {
  const { root } = await mount({ pins: [] });
  expect(trigger()).toBeNull();
  act(() => root.unmount());
});

it("lists who said the pinned message and what, and jumps to it", async () => {
  const { root, onJump } = await mount();
  expect(document.querySelector("[role=menu]")).toBeNull();
  await act(async () => trigger()!.click());
  expect(trigger()!.getAttribute("aria-expanded")).toBe("true");
  expect(items()[0]!.textContent).toBe("PepperShip on Friday");
  expect(document.activeElement).toBe(items()[0]);
  await act(async () => items()[0]!.click());
  expect(onJump).toHaveBeenCalledWith("m1");
  expect(trigger()!.getAttribute("aria-expanded")).toBe("false");
  act(() => root.unmount());
});

it("reaches Unpin with the arrows, and Escape closes the menu back onto its button", async () => {
  const { root, onUnpin } = await mount();
  await act(async () => trigger()!.click());
  await key("ArrowDown");
  expect(document.activeElement).toBe(items()[1]);
  await key("Home");
  expect(document.activeElement).toBe(items()[0]);
  await key("End");
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(onUnpin).toHaveBeenCalledWith("m1");
  await key("Escape");
  expect(trigger()!.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());
  act(() => root.unmount());
});

it("offers no Unpin to someone who cannot change the conversation", async () => {
  const { root } = await mount({ onUnpin: undefined });
  await act(async () => trigger()!.click());
  expect(items()).toHaveLength(1);
  act(() => root.unmount());
});

it("previews only a text message that still exists", () => {
  expect(pinnedPreview([message({})], "m1", "Pepper")).toEqual(PINS);
  expect(pinnedPreview([message({ role: "user" })], "m1", "Pepper")[0]!.sender).toBe("You");
  expect(pinnedPreview([message({})], "gone", "Pepper")).toEqual([]);
  expect(pinnedPreview([message({})], undefined, "Pepper")).toEqual([]);
  expect(pinnedPreview([message({ text: "   " })], "m1", "Pepper")).toEqual([]);
});
