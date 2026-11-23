// @vitest-environment happy-dom
// The / menu in the real composer: skills can be picked anywhere in a message, built-in commands only at its start.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";

const dispatch = vi.hoisted(() => vi.fn());
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot], instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
// The model picker in Advanced mode's footer reads a store this file does not build.
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/use-slash-skills", () => ({
  useSlashSkills: (_botId: string | undefined, _threadId: string, active: boolean) =>
    active ? [{ name: "standup", description: "Writes the weekly standup note." }, { name: "fork-release", description: "Prepares a release." }] : [],
}));
vi.mock("./CallView", () => ({ CallButton: () => null }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "slash-bot", threadId: "slash-thread", name: "Atlas", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [], activeLeafId: "visible-leaf",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const draftId = `bot:${bot.id}:${bot.threadId}`;

describe("the / menu in the composer", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dispatch.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(Composer, { bot })));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fill(text: string, caret = text.length) {
    flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
    const input = container.querySelector("textarea")!;
    input.setSelectionRange(caret, caret);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keyup", { key: "/", bubbles: true })));
    return input;
  }
  const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
  const labels = () => options().map((option) => option.querySelector(".truncate")?.textContent);
  const press = (input: HTMLTextAreaElement, key: string) => flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

  it("offers the built-in commands and skills at the start of a message", () => {
    fill("/");
    expect(labels()).toEqual(["/goal", "/learn", "/setup", "/burst", "/fork", "/fork-release", "/standup"]);
  });

  it("submits a complete /fork as a fork action instead of a message", () => {
    const input = fill("/fork");
    press(input, "Enter");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "forkMessage", kind: "bot", ownerId: bot.id, threadId: bot.threadId, branchLeafId: bot.activeLeafId,
    }));
    expect(input.value).toBe("/fork");
    flushSync(() => dispatch.mock.calls[0]![0].onSuccess());
    expect(input.value).toBe("");
  });

  it("chooses the highlighted skill when it also matches a complete /fork", () => {
    const input = fill("/fork");
    press(input, "ArrowDown");
    expect(options().find((option) => option.getAttribute("aria-selected") === "true")?.textContent).toContain("/fork-release");
    press(input, "Enter");
    expect(input.value).toBe("/fork-release ");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a failed fork command in place and retries it next to the composer", () => {
    const input = fill("/fork");
    press(input, "Enter");
    expect(dispatch.mock.calls[0]![0].onError).toBeTypeOf("function");
    flushSync(() => dispatch.mock.calls[0]![0].onError("Wait for this conversation to finish."));
    const failure = container.querySelector('[role="alert"]')!;
    expect(failure.textContent).toContain("Wait for this conversation to finish.");
    expect(input.value).toBe("/fork");
    flushSync(() => failure.querySelector("button")!.click());
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["forkMessage", "forkMessage"]);
  });

  it("completes /fo with Tab and forks on submission", () => {
    const input = fill("/fo");
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(input.value.trim()).toBe("/fork");
    expect(dispatch).not.toHaveBeenCalled();
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "forkMessage" }));
  });

  it("offers only skills after a space later in the message, and puts the pick in place", () => {
    const input = fill("write it up with /");
    expect(labels()).toEqual(["/fork-release", "/standup"]);
    flushSync(() => options()[1]!.click());
    expect(input.value).toBe("write it up with /standup ");
  });

  it("adds no second space when text already follows the pick", () => {
    const input = fill("use /st later", "use /st".length);
    flushSync(() => options()[0]!.click());
    expect(input.value).toBe("use /standup later");
  });

  it("opens nothing inside a path or link", () => {
    fill("open notes/st");
    expect(options()).toEqual([]);
    fill("see https://x.test/");
    expect(options()).toEqual([]);
  });
});
