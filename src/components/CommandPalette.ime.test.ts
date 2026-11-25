// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: vi.fn(async () => ({ hits: [] })),
    useStore: () => ({ state: { ...original.initialState, bots: [bot], groups: [room] }, dispatch: fixture.dispatch }),
  };
});

import { CommandPalette, openCommandPalette } from "./CommandPalette";

const bot: Bot = {
  id: "ime-bot", threadId: "ime-thread", name: "Shelby", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "",
  modelSelection: { instanceId: "claude", model: "fake" },
};
const room = { id: "ime-room", name: "设计评审", memberIds: [bot.id] } as unknown as Group;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function open() {
  flushSync(() => root.render(createElement(CommandPalette)));
  flushSync(() => openCommandPalette());
  return document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) {
  flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
}

const dialog = () => document.querySelector('[role="dialog"]');

describe("Command palette with an input method", () => {
  it.each([
    { name: "composition", init: { isComposing: true } },
    { name: "IME key code", init: { keyCode: 229 } },
  ])("does not open the top match on the Enter that belongs to the $name", ({ init }) => {
    const input = open();
    type(input, "she");
    press(input, "Enter", init);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("keeps the palette open when Escape only dismisses the candidate list", () => {
    const input = open();
    const onDocumentKey = vi.fn();
    document.addEventListener("keydown", onDocumentKey);
    type(input, "sheji");
    press(input, "Escape", { isComposing: true });
    document.removeEventListener("keydown", onDocumentKey);
    expect(dialog()).not.toBeNull();
    expect(onDocumentKey).not.toHaveBeenCalled();
  });

  it("opens the match on the Enter after the text is committed", () => {
    const input = open();
    type(input, "设计");
    press(input, "Enter");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "select", id: room.id });
    expect(dialog()).toBeNull();
  });
});
