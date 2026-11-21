// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
// Picking a bot from the @ list sends its id with the words, so the bot picked is the one reached even when another
// bot has the same name. Typed names carry no ids. The desktop app and the web app share this composer.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [scout, analyst, chief], instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: () => null }));

import { Composer } from "./Composer";

const scout: Bot = {
  id: "scout", threadId: "scout-thread", name: "Support Scout", title: "Support agent", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const analyst: Bot = { ...scout, id: "quill-analyst", threadId: "analyst-thread", name: "Quill", title: "Analyst", color: "teal" };
const chief: Bot = { ...scout, id: "quill-chief", threadId: "chief-thread", name: "Quill", title: "", color: "purple", chiefOfStaff: true };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: [scout.id, analyst.id, chief.id],
  defaultResponder: { kind: "member", botId: scout.id }, bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
};
const drafts = [`group:${room.id}:${room.threadId}`, `bot:${scout.id}:${scout.threadId}`];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of drafts) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  for (const id of drafts) restoreComposerDraft(id, { text: "", attachments: [] });
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input = () => container.querySelector<HTMLElement & { editor: Editor }>(".composer-editor")!;
function type(draftId: string, text: string) {
  flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
}
const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
function pick(name: string, role: string) {
  const option = options().find((one) => one.textContent?.includes(name) && one.textContent.includes(role));
  if (!option) throw new Error(`no ${name}, ${role} in the @ list: ${options().map((one) => one.textContent).join(" | ")}`);
  flushSync(() => option.click());
}
function send() {
  flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}
const sent = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "sendGroup" || action.type === "send");

describe("a room's @ list", () => {
  beforeEach(() => flushSync(() => root.render(createElement(Composer, { group: room, members: [scout, analyst, chief] }))));

  it("continues a numbered list on Enter and sends its Markdown on Ctrl+Enter", () => {
    const markdown = "2. **bold** and `release`";
    flushSync(() => restoreComposerDraft(drafts[0]!, { text: markdown, attachments: [] }));
    const { editor } = input();
    expect(input().querySelector("ol")?.start).toBe(2);
    expect(input().querySelector("strong")?.textContent).toBe("bold");
    expect(input().querySelector("code")?.textContent).toBe("release");
    send();
    expect(sent()).toEqual([]);
    expect(input().querySelectorAll("li")).toHaveLength(2);
    expect(input().hasAttribute("data-empty")).toBe(false);
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    flushSync(() => editor.commands.insertContent("next"));
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(sent()).toEqual([expect.objectContaining({ text: markdown + "\n3. next" })]);
    expect(editor.isEmpty).toBe(true);
    expect(input().hasAttribute("data-empty")).toBe(true);
  });

  it("recognizes bold after a soft break and combined emphasis", () => {
    type(drafts[0]!, "hello");
    const field = input();
    const { view } = field.editor;
    flushSync(() => field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", shiftKey: true, bubbles: true, cancelable: true,
    })));
    for (const char of "**n** ***both***") {
      flushSync(() => {
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(char, from, to);
        if (!view.someProp("handleTextInput", handle => handle(view, from, to, char, insert))) view.dispatch(insert());
      });
    }
    expect(field.querySelector("br + strong")?.textContent).toBe("n");
    expect(field.querySelector("strong em, em strong")?.textContent).toBe("both");
  });

  it("restores CommonMark, GFM and math as document nodes and marks", () => {
    const markdown = [
      "# Title",
      "> **bold** and *emphasis* with ~~deleted~~ and `code`",
      "- [x] reviewed",
      "| Name | Count |\n| --- | ---: |\n| item | 1 |",
      "[link](https://example.com) ![photo](https://example.com/remote.png)",
      "A note[^check] and $x^2$.",
      "$$\ny^2\n$$",
      "[^check]: Note body",
      "```ts\nconst value = 1\n```",
      "---",
    ].join("\n\n");
    flushSync(() => restoreComposerDraft(drafts[0]!, { text: markdown, attachments: [] }));
    const field = input();
    for (const selector of [
      "h1", "blockquote strong", "em", "s", "code", 'li[data-checked="true"]',
      "table th", "tbody td", "a[href]", "[data-draft-image]", "[data-footnote-ref]",
      "[data-footnote-definition]", '[data-type="inline-math"]', '[data-type="block-math"]', "pre code", "hr",
    ]) expect(field.querySelector(selector), selector).not.toBeNull();
    expect(field.querySelector("img[src]")).toBeNull();
    const restored = field.editor.markdown!.parse(field.editor.getMarkdown());
    expect(field.editor.schema.nodeFromJSON(restored).eq(field.editor.state.doc)).toBe(true);
  });

  it("shows each Quill by its role, and sends the picked one's id", () => {
    type(drafts[0]!, "@Qu");
    expect(options().map((one) => one.textContent)).toEqual([expect.stringContaining("Analyst"), expect.stringContaining("Chief of Staff")]);
    pick("Quill", "Chief of Staff");
    expect(input().textContent).toBe("@Quill ");
    expect(input().querySelector(".composer-mention-trigger")?.textContent).toBe("@");
    expect(input().querySelector(".composer-mention-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(input().querySelector(".bot-mention")?.textContent).toBe("Quill");
    send();
    expect(sent()).toEqual([expect.objectContaining({ type: "sendGroup", groupId: room.id, text: "@Quill", mentions: [chief.id] })]);
  });

  it("keeps the caret outside a multi-word bot mention and extends partial selections", () => {
    type(drafts[0]!, "Ask @Support Scout now");
    const field = input();
    const { editor } = field;
    expect(field.querySelector(".composer-mention-name")?.closest('[contenteditable="false"]')).not.toBeNull();

    flushSync(() => editor.commands.setTextSelection(7));
    expect(editor.state.selection.from).toBe(5);
    flushSync(() => editor.commands.setTextSelection(17));
    expect(editor.state.selection.from).toBe(19);
    flushSync(() => editor.commands.setTextSelection({ from: 7, to: 9 }));
    expect(editor.state.selection.from).toBe(5);
    expect(editor.state.selection.to).toBe(19);
  });

  it.each([
    ["Backspace", 19],
    ["Delete", 5],
    ["deleteContentBackward", 19],
    ["deleteContentForward", 5],
  ] as const)("removes the entire bot mention with %s", (action, position) => {
    type(drafts[0]!, "Ask @Support Scout now");
    const field = input();
    const { editor } = field;
    flushSync(() => editor.commands.setTextSelection(position));
    const event = action === "Backspace" || action === "Delete"
      ? new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true })
      : new InputEvent("beforeinput", { inputType: action, bubbles: true, cancelable: true });
    flushSync(() => field.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(field.textContent).toBe("Ask  now");
    expect(editor.state.selection.from).toBe(5);
  });

  it("sends a typed name with no ids, and forgets a pick once its line is sent", () => {
    type(drafts[0]!, "@Qu");
    pick("Quill", "Analyst");
    send();
    type(drafts[0]!, "@Quill check the numbers");
    send();
    expect(sent().map((action) => action.mentions)).toEqual([[analyst.id], []]);
  });

  it("keeps the pick with words a failed send hands back", () => {
    type(drafts[0]!, "@Qu");
    pick("Quill", "Chief of Staff");
    send();
    flushSync(() => sent()[0]!.onError());
    expect(input().textContent).toBe("@Quill ");
    send();
    expect(sent().map((action) => action.mentions)).toEqual([[chief.id], [chief.id]]);
  });
});

describe("a one-to-one chat's @ list", () => {
  it("sends the picked teammate's id too", () => {
    flushSync(() => root.render(createElement(Composer, { bot: scout })));
    type(drafts[1]!, "ask @Qu");
    pick("Quill", "Analyst");
    send();
    expect(sent()).toEqual([expect.objectContaining({ type: "send", botId: scout.id, text: "ask @Quill", mentions: [analyst.id] })]);
  });
});
