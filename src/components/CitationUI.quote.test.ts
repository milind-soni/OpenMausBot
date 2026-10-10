// @vitest-environment happy-dom
// Selected message text goes straight into the composer: a floating
// "Add to prompt" pill (or its shortcut) adds the quote, and the composer
// shows it as an inline chip before the caret. No popover, no comment form.
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerQuoteChip, CitationSelectionToolbar, quoteLineDirection } from "./CitationUI";
import { MentionTextarea } from "./MentionTextarea";
import { CITATION_MAX_QUOTE_LENGTH, citationAttachment, type CitationAttachment } from "@/lib/citations";
import { addToPromptChord, isAddToPromptShortcut, removesQuoteChip } from "@/lib/citations-dom";
import { SHORTCUT_GROUPS } from "@/lib/keyboard-shortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

const quote = "فهمت عليك. لما تحدد نص وتضغط اقتباس، بدل النافذة اللي تطلع بنص الشاشة";
const citation: CitationAttachment = citationAttachment(
  { ownerType: "bot", ownerId: "bot-1", threadId: "thread-1", messageId: "m-1" },
  { text: quote, prefix: "", suffix: "", start: 0, end: quote.length },
);

describe("the composer quote chip", () => {
  it("shows an icon and the opening words in quotes, the whole quote on hover, and removes on x", () => {
    const onRemove = vi.fn();
    const view = mount(createElement(ComposerQuoteChip, { citation, onRemove }));
    const chip = view.querySelector<HTMLElement>("[data-quote-chip]")!;
    expect(chip.title).toBe(quote);
    expect(chip.querySelector("svg")).not.toBeNull();
    // the x sits over the icon, not after the text, so the caret follows the quote
    expect(chip.lastElementChild!.textContent).toBe(`\u201C${quote}`);
    const text = chip.querySelector<HTMLElement>("span[dir=auto]")!;
    expect(text.textContent).toBe(`\u201C${quote}`);
    expect(text.className).toContain("truncate");
    const remove = chip.querySelector<HTMLButtonElement>("button")!;
    expect(remove.getAttribute("aria-label")).toContain("Remove quote");
    act(() => remove.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("lays the line out in the comment's direction, or the first quote's before one is typed", () => {
    const english = { ...citation, quote: "Onboarding now asks for the workspace name" };
    expect(quoteLineDirection("", [citation])).toBe("rtl");
    expect(quoteLineDirection("", [english, citation])).toBe("ltr");
    expect(quoteLineDirection("why?", [citation])).toBe("ltr");
    expect(quoteLineDirection("  12 ", [citation])).toBe("rtl");
    expect(quoteLineDirection("وضّح أكثر", [english])).toBe("rtl");
  });

  it("sits at the start of the input line, before the textarea, in the line's direction", () => {
    const view = mount(createElement(MentionTextarea, {
      inputRef: createRef<HTMLTextAreaElement>(),
      peers: [],
      dir: "auto",
      value: "",
      readOnly: true,
      leadingDir: "rtl",
      leading: createElement(ComposerQuoteChip, { citation, onRemove: () => {} }),
    }));
    const line = view.querySelector<HTMLElement>("[data-composer-line]")!;
    expect(line.getAttribute("dir")).toBe("rtl");
    const [first, second] = [...line.children];
    expect(first!.hasAttribute("data-quote-chip")).toBe(true);
    expect(second!.querySelector("textarea")).not.toBeNull();
  });

  it("leaves the editor alone when there is no quote", () => {
    const view = mount(createElement(MentionTextarea, { inputRef: createRef<HTMLTextAreaElement>(), peers: [], value: "", readOnly: true }));
    expect(view.querySelector("[data-composer-line]")).toBeNull();
  });
});

describe("the add to prompt shortcut", () => {
  const key = (init: Partial<KeyboardEvent>) => ({ key: "l", code: "KeyL", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...init });

  it("is ⌘L on a Mac and Ctrl+L elsewhere, and nothing else", () => {
    expect(isAddToPromptShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isAddToPromptShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isAddToPromptShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isAddToPromptShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isAddToPromptShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isAddToPromptShortcut(key({ ctrlKey: true, key: "k", code: "KeyK" }), false)).toBe(false);
    // an Arabic layout types a different letter on the L key
    expect(isAddToPromptShortcut(key({ ctrlKey: true, key: "م" }), false)).toBe(true);
    expect(addToPromptChord(true)).toEqual({ text: "\u2318L", aria: "Meta+L" });
    expect(addToPromptChord(false)).toEqual({ text: "Ctrl+L", aria: "Control+L" });
  });

  it("is listed once and takes no other shortcut's keys", () => {
    const items = SHORTCUT_GROUPS.flatMap((group) => group.items);
    const taken = items.filter((item) => item.macKeys.join("+") === "⌘+L" || item.winKeys.join("+") === "Ctrl+L");
    expect(taken.map((item) => item.id)).toEqual(["add-to-prompt"]);
  });
});

describe("the add to prompt pill", () => {
  function selectMessage(body = quote, end = 18) {
    const viewport = document.createElement("div");
    viewport.innerHTML = `<div data-citation-source="m-1" data-citation-owner-type="bot" data-citation-owner="bot-1" data-citation-thread="thread-1"><p>${body}</p></div>`;
    document.body.append(viewport);
    const text = viewport.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return viewport;
  }

  it("floats over a selection and adds the quote on click, with no comment form", () => {
    const viewport = selectMessage();
    const onAdd = vi.fn();
    mount(createElement(CitationSelectionToolbar, { viewportRef: { current: viewport }, onAdd }));
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
    const pill = document.body.querySelector<HTMLButtonElement>("[data-add-to-prompt]")!;
    expect(pill.textContent).toContain("Add to prompt");
    expect(pill.querySelector("kbd")?.textContent).toMatch(/^(\u2318L|Ctrl\+L)$/);
    act(() => pill.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
    const added = onAdd.mock.calls[0]![0] as CitationAttachment;
    expect(added.quote).toBe(quote.slice(0, 18));
    expect(added.comment).toBeUndefined();
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.body.querySelector("[data-add-to-prompt]")).toBeNull();
  });

  it("adds the quote on the shortcut and keeps the key from the page", () => {
    const viewport = selectMessage();
    const onAdd = vi.fn();
    mount(createElement(CitationSelectionToolbar, { viewportRef: { current: viewport }, onAdd }));
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
    const mac = navigator.userAgent.includes("Mac");
    const event = new KeyboardEvent("keydown", { key: "l", code: "KeyL", ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector("[data-add-to-prompt]")).toBeNull();
  });

  it("leaves the shortcut alone when the selection is over the limit", () => {
    const long = "word ".repeat(Math.ceil(CITATION_MAX_QUOTE_LENGTH / 5) + 10).trim();
    const viewport = selectMessage(long, long.length);
    const onAdd = vi.fn();
    mount(createElement(CitationSelectionToolbar, { viewportRef: { current: viewport }, onAdd }));
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
    const pill = document.body.querySelector<HTMLButtonElement>("[data-add-to-prompt]")!;
    expect(pill.disabled).toBe(true);
    expect(pill.textContent).toContain("Shorten selection");
    // the chord itself is valid, so only the length limit can let it through
    const mac = navigator.userAgent.includes("Mac");
    const event = new KeyboardEvent("keydown", { key: "l", code: "KeyL", ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true });
    expect(isAddToPromptShortcut(event, mac)).toBe(true);
    act(() => { document.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("does not take the shortcut when nothing is selected", () => {
    const viewport = document.createElement("div");
    const onAdd = vi.fn();
    mount(createElement(CitationSelectionToolbar, { viewportRef: { current: viewport }, onAdd }));
    const event = new KeyboardEvent("keydown", { key: "l", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(onAdd).not.toHaveBeenCalled();
  });
});

it("takes the newest quote out on Escape or on Backspace right after the chips only", () => {
  const key = (k: string, isComposing = false) => ({ key: k, isComposing });
  expect(removesQuoteChip(key("Escape"), { start: 4, end: 4 })).toBe(true);
  expect(removesQuoteChip(key("Backspace"), { start: 0, end: 0 })).toBe(true);
  expect(removesQuoteChip(key("Backspace"), { start: 3, end: 3 })).toBe(false);
  // a selection from the start deletes typed text, not a quote
  expect(removesQuoteChip(key("Backspace"), { start: 0, end: 5 })).toBe(false);
  expect(removesQuoteChip(key("Backspace", true), { start: 0, end: 0 })).toBe(false);
  expect(removesQuoteChip(key("a"), { start: 0, end: 0 })).toBe(false);
});
