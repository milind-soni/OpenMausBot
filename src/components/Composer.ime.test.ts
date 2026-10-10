// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot, peer], instances: [{
      instanceId: "fake", driverKind: "claude", displayName: "Fake",
      capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "ime-bot", threadId: "ime-thread", name: "Atlas", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "fake", model: "fake" },
};
const peer: Bot = { ...bot, id: "ime-peer", name: "調査担当" };
const draftId = `bot:${bot.id}:${bot.threadId}`;

describe("Japanese IME in the real composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onEditLast = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(Composer, { bot, onEditLast })));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fill(text: string) {
    flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
    const input = container.querySelector("textarea")!;
    input.setSelectionRange(text.length, text.length);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true })));
    return input;
  }

  function press(input: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    flushSync(() => input.dispatchEvent(event));
    return event;
  }

  it.each([
    { name: "composition", init: { isComposing: true } },
    { name: "IME key code", init: { isComposing: false, keyCode: 229 } },
  ])("leaves candidate keys to the $name without selecting mentions or commands", ({ init }) => {
    for (const draft of ["@", "/"]) {
      const input = fill(draft);
      expect(container.querySelector('[role="listbox"]')).not.toBeNull();
      for (const key of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"]) {
        expect(press(input, key, init).defaultPrevented).toBe(false);
        expect(input.value).toBe(draft);
        expect(container.querySelector('[role="listbox"]')).not.toBeNull();
      }
      expect(fixture.dispatch).not.toHaveBeenCalled();
    }
  });

  it("does not send or edit the previous message while composing", () => {
    const input = fill("日本語を入力中");
    expect(press(input, "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(press(input, "Enter", { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(input.value).toBe("日本語を入力中");
    fill("");
    press(input, "ArrowUp", { isComposing: true });
    expect(onEditLast).not.toHaveBeenCalled();
  });

  it("still selects a Japanese mention and sends on the next ordinary Enter", () => {
    const input = fill("@調");
    expect(press(input, "Enter").defaultPrevented).toBe(true);
    expect(input.value).toBe("@調査担当 ");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    press(input, "Enter");
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "send", botId: bot.id, text: "@調査担当",
    }));
  });

  it("keeps ordinary slash selection and Shift+Enter working", () => {
    const input = fill("/se");
    press(input, "Enter");
    expect(input.value).toBe("/setup ");
    expect(press(input, "Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
