// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { restoreComposerDraft, recoverFailedComposerSend, draftRevision, markDraftEdited } from "@/lib/drafts";
import { directMessageSent } from "@/lib/product-events";
import { setSendKey } from "@/lib/send-key";
import { setNewlineKey } from "@/lib/newline-key";
import { setSteerKey } from "@/lib/steer-key";
import { addPointedChip, forgetPointedChips, takePointedChips } from "@/lib/pointed-chips";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), canSteer: true }));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, api: vi.fn().mockResolvedValue({}), useStore: () => ({ state: { ...actual.initialState, bots: [bot], pendingQueued: { [bot.threadId]: [{ queueId: "q1", text: "keep this" }] }, instances: [{ instanceId: "fake", capabilities: { queueing: fixture.canSteer } }] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/product-events", () => ({ directMessageSent: vi.fn(), roomMessageSent: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("@/lib/use-slash-skills", () => ({ useSlashSkills: () => [] }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
import { Composer } from "./Composer";
const bot: Bot = { id: "delivery-bot", threadId: "delivery-thread", activeRunId: "run-pinned", name: "Fixture", title: "", description: "", color: "blue", notifications: false, unread: false, busy: true, messages: [], modelSelection: { instanceId: "fake", model: "fake" } };
const draftId = `bot:${bot.id}:${bot.threadId}`;
beforeEach(() => {
  forgetPointedChips();
  setNewlineKey("auto"); setSendKey("enter"); setSteerKey("off"); markDraftEdited(draftId);
  fixture.canSteer = true; bot.busy = true;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => { forgetPointedChips(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  flushSync(() => root.render(createElement(Composer, { bot })));
  return {
    host,
    fill: (text = "架空の指示") => flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] })),
    press: (init: KeyboardEventInit = {}) => flushSync(() => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }))),
    cleanup: () => { flushSync(() => root.unmount()); host.remove(); restoreComposerDraft(draftId, { text: "", attachments: [] }); },
  };
};
it.each(["enter", "mod-enter", "shift-enter"] as const)("preserves the existing arrow and %s send key when steering is disabled", key => {
  setSendKey(key);
  const page = mount();
  try {
    page.fill(); page.press({ isComposing: true }); page.press({ keyCode: 229 });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(page.host.querySelector('button[title^="Send ("]')).not.toBeNull();
    expect(page.host.textContent).not.toContain("Add to current run");
    expect(page.host.textContent).not.toContain("Add to queue");
    page.press(key === "mod-enter" ? { metaKey: true } : key === "shift-enter" ? { shiftKey: true } : {});
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "send", delivery: { mode: "queue" } }));
    expect(directMessageSent).toHaveBeenLastCalledWith(expect.anything(), "fake", true);
    fixture.dispatch.mockClear(); page.press(); page.press();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(page.host.textContent).toContain("keep this");
  } finally { page.cleanup(); }
});
it("uses the opted-in modifier key only for the pinned current run, without changing the UI or queue", () => {
  setSteerKey("mod");
  const page = mount();
  try {
    page.fill(); page.press({ metaKey: true, isComposing: true }); page.press({ metaKey: true, keyCode: 229 });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    page.press({ shiftKey: true }); expect(fixture.dispatch).not.toHaveBeenCalled();
    page.press({ metaKey: true });
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: { mode: "steer", runId: "run-pinned" } }));
    expect(page.host.textContent).toContain("keep this");
    expect(page.host.textContent).not.toContain("Add to current run");
  } finally { page.cleanup(); }
});

it.each(["queue", "steer"] as const)("keeps pointed chips alongside %s delivery and restores them with a failed draft", mode => {
  if (mode === "steer") setSteerKey("mod");
  const page = mount();
  const pointed = { appId: "page-fixture", rev: 1, tag: "button", role: "button", text: "Choose", selector: "button", html: "<button>Choose</button>" };
  try {
    page.fill("この箇所を変更");
    flushSync(() => addPointedChip(bot.threadId, { ...pointed, title: "Fixture page" }));
    page.press(mode === "steer" ? { metaKey: true } : {});
    const sent = fixture.dispatch.mock.calls.map(([action]) => action).find(action => action.type === "send");
    expect(sent).toMatchObject({ delivery: mode === "steer" ? { mode, runId: "run-pinned" } : { mode }, pointed: [pointed] });
    expect(takePointedChips(bot.threadId)).toBeNull();
    flushSync(() => sent.onError());
    expect(takePointedChips(bot.threadId)?.pointed).toEqual([pointed]);
    expect(page.host.querySelector("textarea")!.value).toBe("この箇所を変更");
  } finally { page.cleanup(); }
});
it.each([false, true])("refuses an unavailable explicit key without falling back (idle=%s)", idle => {
  setSteerKey("mod"); bot.busy = !idle; fixture.canSteer = false;
  const page = mount();
  try {
    page.fill("keep my draft"); page.press({ ctrlKey: true });
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error" }));
    expect(fixture.dispatch.mock.calls.some(([action]) => action.type === "send")).toBe(false);
    expect(page.host.querySelector("textarea")!.value).toBe("keep my draft");
  } finally { page.cleanup(); }
});
it("rejects conflicting persisted shortcuts instead of guessing a delivery mode", () => {
  setSendKey("mod-enter"); setSteerKey("mod");
  const page = mount();
  try {
    page.fill(); page.press({ metaKey: true });
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", message: expect.stringContaining("same key") }));
    expect(fixture.dispatch.mock.calls.some(([action]) => action.type === "send")).toBe(false);
  } finally { page.cleanup(); }
});
it("keeps the original retry intent; a changed target cannot be selected by the steer key", () => {
  setSteerKey("mod"); const page = mount();
  try {
    flushSync(() => recoverFailedComposerSend({ draftId, revision: draftRevision(draftId), sendId: "retry-pinned-send", text: "retry words", requestText: "retry words", threadId: bot.threadId, attachments: [], delivery: { mode: "steer", runId: "original-run" } }));
    page.press({ metaKey: true });
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error" }));
    page.press();
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ sendId: "retry-pinned-send", delivery: { mode: "steer", runId: "original-run" } }));
  } finally { page.cleanup(); }
});

it.each([
  ["mod", { metaKey: true }],
  ["mod-shift", { ctrlKey: true, shiftKey: true }],
  ["alt", { altKey: true }],
] as const)("inserts a selected %s newline at the selection without sending, including during IME confirmation", (newline, event) => {
  setNewlineKey(newline);
  const page = mount();
  try {
    page.fill("前半置換後半");
    const input = page.host.querySelector("textarea")!;
    input.setSelectionRange(2, 4);
    page.press({ ...event, isComposing: true });
    page.press({ ...event, keyCode: 229 });
    expect(input.value).toBe("前半置換後半");
    page.press(event);
    expect(input.value).toBe("前半\n後半");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    page.press();
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "send", text: "前半\n後半", delivery: { mode: "queue" } }));
  } finally { page.cleanup(); }
});
it.each(["send", "steer"] as const)("blocks a persisted newline collision with %s without altering the draft", action => {
  setNewlineKey(action === "send" ? "enter" : "mod");
  if (action === "steer") setSteerKey("mod");
  const page = mount();
  try {
    page.fill("keep draft"); page.press(action === "steer" ? { metaKey: true } : {});
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", message: expect.stringContaining("same key") }));
    expect(fixture.dispatch.mock.calls.some(([a]) => a.type === "send")).toBe(false);
    expect(page.host.querySelector("textarea")!.value).toBe("keep draft");
  } finally { page.cleanup(); }
});

it.each(["enter", "shift-enter"] as const)("leaves the selected %s newline to native editing and undo", newline => {
  setNewlineKey(newline);
  if (newline === "enter") setSendKey("mod-enter");
  const page = mount();
  try {
    page.fill("before after");
    const input = page.host.querySelector("textarea")!;
    input.setSelectionRange(6, 6);
    const key = new KeyboardEvent("keydown", { key: "Enter", shiftKey: newline === "shift-enter", bubbles: true, cancelable: true });
    flushSync(() => input.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(false);
    expect(input.selectionStart).toBe(6);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  } finally { page.cleanup(); }
});
