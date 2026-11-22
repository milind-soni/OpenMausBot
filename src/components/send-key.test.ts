// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { createElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, InstanceInfo } from "@/state/store";
import { SEND_KEYS, type SendKey } from "@/lib/send-key";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), instances: [] as unknown[], config: undefined as unknown, tourOpen: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: vi.fn(async () => ({})), useStore: () => ({
    state: { ...original.initialState, instances: fixture.instances, config: fixture.config ?? original.initialState.config, tourOpen: fixture.tourOpen },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
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
const { ChatV2 } = await import("./chat-v2/ChatV2");
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

const composer = () => host.querySelector<HTMLElement & { editor: Editor }>(".composer-editor")!;
function typeComposer(value: string) {
  const { editor } = composer();
  flushSync(() => {
    editor.commands.setContent(value, { contentType: "markdown" });
    editor.commands.setTextSelection(editor.state.doc.content.size);
  });
}

/** A keydown as the browser delivers it; prevented means the box sent. */
function press(input: Element, init: KeyboardEventInit & { keyCode?: number } = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...init });
  flushSync(() => input.dispatchEvent(event));
  return event;
}

const sends = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => ["send", "sendGroup", "editMessage"].includes(action.type));

function expectSendKey(mode: SendKey, input: () => HTMLElement, sent: () => number) {
  const ime = [{ isComposing: true }, { keyCode: 229 }, { isComposing: true, shiftKey: true }, { keyCode: 229, shiftKey: true }, { isComposing: true, ctrlKey: true }, { keyCode: 229, metaKey: true }];
  for (const init of ime) {
    expect(press(input(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
  }
  expect(sent()).toBe(0);
  const newLines = mode === "enter" ? [{ shiftKey: true }] : mode === "shift-enter" ? [{}] : [{}, { shiftKey: true }];
  for (const init of newLines) {
    const event = press(input(), init);
    if (input() instanceof HTMLTextAreaElement) expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
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
  fixture.tourOpen = false;
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
    typeComposer("first");
    expectSendKey(mode, composer, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "send", botId: "bot", text: "first" })]);
    typeComposer("second");
    expect(press(composer(), { metaKey: true }).defaultPrevented).toBe(true);
    expect(sends().at(-1)).toEqual(expect.objectContaining({ type: "send", text: "second" }));
    typeComposer("third");
    expect(press(composer(), { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(sends().at(-1)).toEqual(expect.objectContaining({ type: "send", text: "third" }));
  });

  it("a room's composer follows the same key", () => {
    render(createElement(Composer, { group: room, members: [bot] }));
    typeComposer("hello room");
    expectSendKey(mode, composer, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "sendGroup", groupId: "room", text: "hello room" })]);
  });

  it("edits the latest sent message from the empty composer", () => {
    render(createElement(ChatV2, { profile: { ...bot, messages: [{ id: "ask", role: "user", kind: "text", at: 1, text: "Try the new model" }] } }));
    flushSync(() => composer().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    const editor = host.querySelector<HTMLInputElement>('input[name="text"]')!;
    expect(editor.value).toBe("Try the new model");
    flushSync(() => editor.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
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
    const job = () => textarea('textarea[aria-label="What should the Cloud do while you\'re away?"]');
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
    typeComposer("@山田");
    for (const init of ime) {
      for (const key of ["Enter", "Tab", "ArrowDown"]) {
        expect(press(composer(), { ...init, key }).defaultPrevented, JSON.stringify({ ...init, key })).toBe(false);
      }
      expect(composer().textContent).toBe("@山田");
    }
    expect(press(composer()).defaultPrevented).toBe(true);
    expect(composer().textContent).toBe("@山田 ");
    expect(sends()).toEqual([]);
  });

  it("leaves it to the input method in the command menu too", () => {
    render(createElement(Composer, { group: room, members: [bot] }));
    typeComposer("/go");
    for (const init of ime) {
      expect(press(composer(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
      expect(composer().textContent).toBe("/go");
    }
    expect(press(composer()).defaultPrevented).toBe(true);
    expect(composer().textContent).toBe("");
    expect(sends()).toEqual([]);
  });
});

describe("the send key in hints", () => {
  it("names the key on the send button and in the busy composer", () => {
    fixture.instances = [{ instanceId: "test", driverKind: "codex", displayName: "Test", capabilities: { queueing: true } } as unknown as InstanceInfo];
    render(createElement(Composer, { bot }));
    typeComposer("hi");
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Enter)");
    flushSync(() => setSendKey("shift-enter"));
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Shift+Enter)");
    flushSync(() => setSendKey("mod-enter"));
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Ctrl+Enter)");

    typeComposer("");
    render(createElement(Composer, { bot: { ...bot, busy: true, tasks: [{ ...bot.tasks![0]!, busy: true }] } }));
    expect(composer().getAttribute("aria-placeholder")).toBe("Pepper is working. Ctrl+Enter sends your message");
    render(createElement(Composer, { group: { ...room, busyBotId: "bot" }, members: [{ ...bot, modelSelection: { instanceId: "none", model: "x" } }] }));
    expect(composer().getAttribute("aria-placeholder")).toBe("Pepper is working. Ctrl+Enter sends your message");
  });

  it("names the key in Japanese hints too", () => {
    fixture.instances = [{ instanceId: "test", driverKind: "codex", displayName: "Test", capabilities: { queueing: true } } as unknown as InstanceInfo];
    setSendKey("mod-enter");
    setLocale("ja");
    try {
      render(createElement(Composer, { bot: { ...bot, busy: true, tasks: [{ ...bot.tasks![0]!, busy: true }] } }));
      expect(composer().getAttribute("aria-placeholder")).toBe("Pepper が作業中です — Ctrl+Enter でメッセージを送ります");
    } finally {
      setLocale("en");
    }
  });

  it.each([
    ["enter", "Enter"], ["shift-enter", "Shift+Enter"], ["mod-enter", "Ctrl+Enter"],
  ] as const)("names the key in the tour's composer step (%s)", (mode, label) => {
    fixture.config = { onboarding: { completedAt: 1, hintsSeen: [] } };
    fixture.tourOpen = true; // started from Settings: the app tour never starts by itself
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

describe("sending while working", () => {
  const working = { ...bot, busy: true, tasks: [{ ...bot.tasks![0]!, busy: true }] };

  it.each([true, false])("sends in the ordinary path regardless of steering support (%s)", (queueing) => {
    fixture.instances = [{ instanceId: "test", driverKind: "codex", displayName: "Test", capabilities: { queueing } } as unknown as InstanceInfo];
    render(createElement(Composer, { bot: working }));
    for (const key of [{}, { ctrlKey: true }, { metaKey: true }]) {
      typeComposer("follow up");
      expect(press(composer(), key).defaultPrevented).toBe(true);
      expect(sends().at(-1)).toMatchObject({ type: "send", text: "follow up" });
    }
    typeComposer("clicked");
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    flushSync(() => button.click());
    expect(sends().at(-1)).toMatchObject({ type: "send", text: "clicked" });
  });

  it("sends a room message normally while a member is working", () => {
    render(createElement(Composer, { group: { ...room, busyBotId: bot.id }, members: [bot] }));
    typeComposer("room follow up");
    expect(press(composer()).defaultPrevented).toBe(true);
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "sendGroup", text: "room follow up" }));
  });
});
