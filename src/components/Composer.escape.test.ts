// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), finishIntake: () => {} }));
const ADDED_CLAUDE = "claude-5b0e1d2c-7a4f-4e1b-9c3d-2f6a8b1c4d5e";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot, peer], instances: [{
      instanceId: ADDED_CLAUDE, driverKind: "claudeAgent", displayName: "Claude",
      capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("@/lib/attach-notice", () => ({
  intakeFilesWithNotice: () => new Promise((resolve) => {
    fixture.finishIntake = () => resolve({ attachments: [], notice: null });
  }),
}));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "escape-bot", threadId: "escape-thread", name: "Atlas", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: ADDED_CLAUDE, model: "fake" },
};
const peer: Bot = { ...bot, id: "escape-peer", name: "Scout" };
const draftId = `bot:${bot.id}:${bot.threadId}`;
const reply: Message = { id: "m1", role: "bot", kind: "text", text: "Earlier answer", at: 1 };

describe("Escape in the composer", () => {
  let root: Root;
  let container: HTMLDivElement;

  function render(props: Partial<Parameters<typeof Composer>[0]> = {}) {
    flushSync(() => root.render(createElement(Composer, { bot, ...props })));
    return container.querySelector("textarea")!;
  }

  function focusWith(input: HTMLTextAreaElement, text: string) {
    flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
    input.focus();
    input.setSelectionRange(text.length, text.length);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true })));
  }

  function pressEscape(input: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init })));
  }

  function pasteFile(input: HTMLTextAreaElement) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } });
    flushSync(() => input.dispatchEvent(event));
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  async function finishIntake() {
    fixture.finishIntake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextFrame();
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves the composer with nothing to dismiss, keeping the draft", () => {
    const input = render();
    focusWith(input, "half a thought");
    pressEscape(input);
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("half a thought");
  });

  it("closes an open mention picker first and stays in the composer", () => {
    const input = render();
    focusWith(input, "@");
    expect(container.querySelector('[role="listbox"]:not([inert])')?.textContent).toContain(peer.name);
    pressEscape(input);
    expect(container.querySelector('[role="listbox"]:not([inert])')).toBeNull();
    expect(document.activeElement).toBe(input);
    pressEscape(input);
    expect(document.activeElement).not.toBe(input);
  });

  it("cancels a reply first and stays in the composer", () => {
    const onClearReply = vi.fn();
    const input = render({ replyTo: reply, onClearReply });
    focusWith(input, "");
    pressEscape(input);
    expect(onClearReply).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
  });

  it("stays in the composer while an input method is composing", () => {
    const input = render();
    focusWith(input, "にほん");
    pressEscape(input, { isComposing: true });
    expect(document.activeElement).toBe(input);
  });

  it("stays in the composer when a window handler already took the Escape", () => {
    const input = render();
    focusWith(input, "");
    const takeEscape = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", takeEscape, true);
    try {
      pressEscape(input);
    } finally {
      window.removeEventListener("keydown", takeEscape, true);
    }
    expect(document.activeElement).toBe(input);
  });

  it("stays out of the composer when a pasted file finishes after Escape", async () => {
    const input = render();
    await nextFrame();
    focusWith(input, "");
    pasteFile(input);
    pressEscape(input);
    await finishIntake();
    expect(document.activeElement).not.toBe(input);
  });

  it("stays out of the composer when Escape comes between a finished paste and its refocus", async () => {
    const frames: FrameRequestCallback[] = [];
    const runFrames = () => frames.splice(0).forEach((frame) => frame(0));
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const input = render();
    runFrames();
    focusWith(input, "");
    pasteFile(input);
    fixture.finishIntake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(1);
    pressEscape(input);
    runFrames();
    expect(document.activeElement).not.toBe(input);
  });

  it("still returns to the composer when a pasted file finishes without Escape", async () => {
    const input = render();
    await nextFrame();
    focusWith(input, "");
    pasteFile(input);
    input.blur();
    await finishIntake();
    expect(document.activeElement).toBe(input);
  });
});
