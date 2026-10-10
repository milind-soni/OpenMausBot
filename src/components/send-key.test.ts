// @vitest-environment happy-dom
// Settings → Appearance → Send messages with, in every box that sends on
// Enter: the composer (1:1 and rooms), editing a sent message, a citation's
// comment and the Cloud's first job; the hints and the tour name it. Ctrl/⌘+Enter
// always sends, and an input method's confirming Enter never sends nor picks
// from the composer's menus.
import { createElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, InstanceInfo } from "@/state/store";
import { SEND_KEYS, type SendKey } from "@/lib/send-key";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), instances: [] as unknown[], config: undefined as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: vi.fn(async () => ({})), useStore: () => ({
    state: { ...original.initialState, instances: fixture.instances, config: fixture.config ?? original.initialState.config },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null }));
vi.mock("./CitationUI", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CitationUI")>(),
  CitationSelectionToolbar: () => createElement("span"),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));
vi.mock("@/components/Avatar", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/Avatar")>(),
  MausAvatar: () => null,
}));
// The tour's text, without measuring an anchor on screen.
vi.mock("./onboarding/Spotlight", () => ({ Spotlight: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("@/components/onboarding/view-transition", () => ({ withViewTransition: (update: () => void) => { update(); return null; } }));

const { Composer } = await import("./Composer");
const { ChatView } = await import("./ChatView");
const { CitationBadge } = await import("./CitationUI");
const { CloudIntent } = await import("./CloudIntent");
const { GuidedTour } = await import("./onboarding/GuidedTour");
const { setSendKey } = await import("@/lib/send-key");
const { setPendingIntent } = await import("@/lib/cloud-intent");
const { setLocale } = await import("@/lib/i18n");
const { api } = await import("@/state/store");

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};
const room = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: ["bot"],
  defaultResponder: { kind: "member", botId: "bot" }, bulletin: "", unread: false,
  createdAt: 1, messages: [],
} as unknown as Group;

let host: HTMLDivElement;
let root: Root;
const render = (element: ReactElement) => flushSync(() => root.render(element));
const textarea = (selector = "textarea") => host.querySelector<HTMLTextAreaElement>(selector)!;

function type(input: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  flushSync(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A keydown as the browser delivers it; prevented means the box sent. */
function press(input: Element, init: KeyboardEventInit & { keyCode?: number } = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...init });
  flushSync(() => input.dispatchEvent(event));
  return event;
}

const sends = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => ["send", "sendGroup", "editMessage"].includes(action.type));

/** The same presses in each box, and what each one does in each mode: the
 * chosen key sends once, every other Enter is left to the browser as a new
 * line, and nothing sends while an input method composes. */
function expectSendKey(mode: SendKey, input: () => HTMLTextAreaElement, sent: () => number) {
  const ime = [{ isComposing: true }, { keyCode: 229 }, { isComposing: true, shiftKey: true }, { keyCode: 229, shiftKey: true }, { isComposing: true, ctrlKey: true }, { keyCode: 229, metaKey: true }];
  for (const init of ime) {
    expect(press(input(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
  }
  expect(sent()).toBe(0);
  const newLines = mode === "enter" ? [{ shiftKey: true }] : mode === "shift-enter" ? [{}] : [{}, { shiftKey: true }];
  for (const init of newLines) {
    expect(press(input(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
  }
  expect(sent()).toBe(0);
  const send = mode === "enter" ? {} : mode === "shift-enter" ? { shiftKey: true } : { ctrlKey: true };
  expect(press(input(), send).defaultPrevented).toBe(true);
  expect(sent()).toBe(1);
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  vi.mocked(api).mockClear();
  fixture.instances = [];
  fixture.config = undefined;
  setSendKey("enter");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe.each(SEND_KEYS)("in %s mode", (mode) => {
  beforeEach(() => setSendKey(mode));

  it("the 1:1 composer sends on its key, and Ctrl/⌘+Enter always", () => {
    render(createElement(Composer, { bot }));
    type(textarea(), "first");
    expectSendKey(mode, textarea, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "send", botId: "bot", text: "first" })]);
    type(textarea(), "second");
    expect(press(textarea(), { metaKey: true }).defaultPrevented).toBe(true);
    expect(sends().at(-1)).toEqual(expect.objectContaining({ type: "send", text: "second" }));
    type(textarea(), "third");
    expect(press(textarea(), { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(sends().at(-1)).toEqual(expect.objectContaining({ type: "send", text: "third" }));
  });

  it("a room's composer follows the same key", () => {
    render(createElement(Composer, { group: room, members: [bot] }));
    type(textarea(), "hello room");
    expectSendKey(mode, textarea, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "sendGroup", groupId: "room", text: "hello room" })]);
  });

  it("editing a sent message submits on the same key", () => {
    render(createElement(ChatView, { bot: { ...bot, messages: [{ id: "ask", role: "user", kind: "text", at: 1, text: "Try the new model" }] } }));
    const edit = host.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')!;
    flushSync(() => edit.click());
    const editor = () => host.querySelector<HTMLTextAreaElement>("textarea:not([aria-label])")!;
    expect(editor().value).toBe("Try the new model");
    expectSendKey(mode, editor, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "editMessage", messageId: "ask", text: "Try the new model" })]);
  });

  it("a citation's comment saves on the same key", () => {
    const onChange = vi.fn();
    const citation = { kind: "citation", version: 1, id: "c1", quote: "the quote", comment: "why", size: 12,
      source: { ownerType: "bot", ownerId: "bot", threadId: "selected", messageId: "m1", start: 0, end: 9, prefix: "", suffix: "" } } as const;
    render(createElement(CitationBadge, { citation, onChange }));
    flushSync(() => host.querySelector<HTMLButtonElement>("button")!.click());
    const editButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Edit comment")!;
    flushSync(() => editButton.click());
    const comment = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]')!;
    expectSendKey(mode, comment, () => onChange.mock.calls.length);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![0]).toMatchObject({ id: "c1", comment: "why" });
  });

  it("the Cloud's first job starts on the same key", () => {
    setPendingIntent("Watch my inbox");
    render(createElement(CloudIntent));
    const job = () => textarea('textarea[aria-label="What should My Cloud do while you\'re away?"]');
    expect(job().value).toBe("Watch my inbox");
    const given = () => vi.mocked(api).mock.calls.filter(([, init]) => String(init?.body).includes("cloud-intent-given")).length;
    expectSendKey(mode, job, given);
    expect(given()).toBe(1);
    setPendingIntent(null);
  });
});

describe("an input method in the composer's menus", () => {
  const ime = [{ isComposing: true }, { keyCode: 229 }];

  it("leaves the Enter that confirms 山田 to the input method, not the mention menu", () => {
    render(createElement(Composer, { group: room, members: [{ ...bot, name: "山田" }] }));
    type(textarea(), "@山田");
    for (const init of ime) {
      for (const key of ["Enter", "Tab", "ArrowDown"]) {
        expect(press(textarea(), { ...init, key }).defaultPrevented, JSON.stringify({ ...init, key })).toBe(false);
      }
      expect(textarea().value).toBe("@山田");
    }
    expect(press(textarea()).defaultPrevented).toBe(true);
    expect(textarea().value).toBe("@山田 ");
    expect(sends()).toEqual([]);
  });

  it("leaves it to the input method in the command menu too", () => {
    render(createElement(Composer, { group: room, members: [bot] }));
    type(textarea(), "/go");
    for (const init of ime) {
      expect(press(textarea(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
      expect(textarea().value).toBe("/go");
    }
    expect(press(textarea()).defaultPrevented).toBe(true);
    expect(textarea().value).toBe("");
    expect(sends()).toEqual([]);
  });
});

describe("the send key in hints", () => {
  it("names the key on the send button and in the busy composer", () => {
    fixture.instances = [{ instanceId: "test", driverKind: "codex", displayName: "Test", capabilities: { queueing: true } } as unknown as InstanceInfo];
    render(createElement(Composer, { bot }));
    type(textarea(), "hi");
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Enter)");
    flushSync(() => setSendKey("shift-enter"));
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Shift+Enter)");
    flushSync(() => setSendKey("mod-enter"));
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Ctrl+Enter)");

    type(textarea(), "");
    render(createElement(Composer, { bot: { ...bot, busy: true, tasks: [{ ...bot.tasks![0]!, busy: true }] } }));
    expect(textarea().placeholder).toBe("Pepper is working — Ctrl+Enter sends this into the running turn");
    render(createElement(Composer, { group: { ...room, busyBotId: "bot" }, members: [{ ...bot, modelSelection: { instanceId: "none", model: "x" } }] }));
    expect(textarea().placeholder).toBe("Pepper is working — Ctrl+Enter queues your message");
  });

  it("names the key in Japanese hints too", () => {
    fixture.instances = [{ instanceId: "test", driverKind: "codex", displayName: "Test", capabilities: { queueing: true } } as unknown as InstanceInfo];
    setSendKey("mod-enter");
    setLocale("ja");
    try {
      render(createElement(Composer, { bot: { ...bot, busy: true, tasks: [{ ...bot.tasks![0]!, busy: true }] } }));
      expect(textarea().placeholder).toBe("Pepper が作業中です — Ctrl+Enter で実行中のターンに送ります");
    } finally {
      setLocale("en");
    }
  });

  it.each([
    ["enter", "Enter"], ["shift-enter", "Shift+Enter"], ["mod-enter", "Ctrl+Enter"],
  ] as const)("names the key in the tour's composer step (%s)", (mode, label) => {
    fixture.config = { onboarding: { completedAt: 1, hintsSeen: [] } };
    setSendKey(mode);
    render(createElement(GuidedTour));
    expect(document.body.textContent).toContain(`Type anything and press ${label}. Every chat`);
  });

  it("names the key on the Cloud's first-job button", () => {
    setSendKey("mod-enter");
    render(createElement(CloudIntent));
    expect(host.querySelector('button[aria-label="Start setting it up"]')?.getAttribute("title")).toBe("Start setting it up (Ctrl+Enter)");
  });
});
