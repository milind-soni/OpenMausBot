// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: fixture.api,
    useStore: () => ({ state: { ...original.initialState, bots: [bot], sections: ["Research"] }, dispatch: fixture.dispatch }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { NewRoomPanel } from "./SidebarNewRoomPanel";
import { TeamDialog } from "./TeamDialog";

const bot: Bot = {
  id: "ime-bot", threadId: "ime-thread", name: "Atlas", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "Research",
  modelSelection: { instanceId: "claude", model: "fake" },
};

const composing = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

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
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
}

describe("New channel panel with an input method", () => {
  function open() {
    const onClose = vi.fn();
    flushSync(() => root.render(createElement(NewRoomPanel, { onClose })));
    flushSync(() => document.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Atlas"]')!.click());
    const [name, section] = [...document.querySelectorAll<HTMLInputElement>("input")];
    return { onClose, name, section };
  }

  it.each(composing)("does not create the channel or close on keys that belong to the $name", ({ init }) => {
    const { onClose, name, section } = open();
    for (const input of [name, section]) {
      type(input, "kaifa");
      press(input, "Enter", init);
      press(input, "Escape", init);
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("creates the channel on the Enter after the text is committed", () => {
    const { onClose, name } = open();
    type(name, "开发");
    press(name, "Enter");
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "createGroup", name: "开发", memberIds: [bot.id] }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Team dialog with an input method", () => {
  it.each(composing)("does not save a half-typed name or close on keys that belong to the $name", ({ init }) => {
    const onClose = vi.fn();
    flushSync(() => root.render(createElement(TeamDialog, { section: "Research", rename: true, onClose })));
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    type(input, "yanjiu");
    press(input, "Enter", init);
    press(input, "Escape", init);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renames on the Enter after the text is committed", async () => {
    fixture.api.mockResolvedValue({ sections: ["研究"] });
    const onClose = vi.fn();
    const onRenamed = vi.fn();
    flushSync(() => root.render(createElement(TeamDialog, { section: "Research", rename: true, onClose, onRenamed })));
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    type(input, "研究");
    press(input, "Enter");
    await vi.waitFor(() => expect(onRenamed).toHaveBeenCalledWith("Research", "研究"));
    expect(fixture.api).toHaveBeenCalledWith(
      "/api/sidebar-sections?section=Research",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "研究" }) }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("composing keys stay inside the dialog", () => {
  // The phone sidebar drawer closes on any Escape that reaches document.
  it.each(composing)("does not let the $name Escape reach document", ({ init }) => {
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    try {
      flushSync(() => root.render(createElement(NewRoomPanel, { onClose: vi.fn() })));
      for (const input of document.querySelectorAll<HTMLInputElement>("input")) press(input, "Escape", init);
      flushSync(() => root.render(createElement(TeamDialog, { section: "Research", rename: true, onClose: vi.fn() })));
      press(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, "Escape", init);
      expect(outside).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outside);
    }
  });
});
