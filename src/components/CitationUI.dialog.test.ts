// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CITATION_MAX_COMMENT_LENGTH, type CitationAttachment } from "@/lib/citations";
import { CitationBadge } from "./CitationUI";

const citation: CitationAttachment = {
  kind: "citation", version: 1, id: "c1", quote: "first line\nsecond line", comment: "why", size: 22,
  source: { ownerType: "bot", ownerId: "b1", threadId: "t1", messageId: "m1", start: 0, end: 22, prefix: "", suffix: "" },
};

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
const dialog = (label: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
const button = (within: HTMLElement, text: string) => [...within.querySelectorAll("button")].find((one) => one.textContent === text)!;
const classes = (element: Element) => element.className.split(/\s+/);
const press = (target: Element, key: string) => flushSync(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
function type(input: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  flushSync(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  onChange.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  flushSync(() => root.render(createElement(CitationBadge, { citation, onChange, onNavigate: async () => true })));
  flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Open citation"]')!.click());
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function openEditor(): HTMLElement {
  flushSync(() => button(dialog("Citation details")!, "Edit comment").click());
  return dialog("Comment on citation")!;
}

function expectSharedLook(card: HTMLElement) {
  expect(classes(card)).toEqual(expect.arrayContaining(["popover-surface", "bg-menu", "rounded-xl", "text-start"]));
  expect(card.querySelector("pre")).toBeNull();
  const quote = card.querySelector<HTMLElement>("[data-citation-quote]")!;
  expect(quote.textContent).toBe(citation.quote);
  expect(quote.getAttribute("dir")).toBe("auto");
  expect(classes(quote)).toEqual(expect.arrayContaining(["whitespace-pre-wrap", "border-s-2", "border-hairline"]));
  expect(card.innerHTML).not.toMatch(/uppercase|text-\[1[01]px\]|text-white|bg-accent/);
  for (const one of card.querySelectorAll("button")) {
    expect(classes(one)).toContain("ui-button");
    expect(one.className).not.toMatch(/text-\[|rounded-/);
  }
}

describe("citation card and details pop-up", () => {
  it("draws the details pop-up on the shared popover surface, with shared buttons and no primary", () => {
    const details = dialog("Citation details")!;
    expectSharedLook(details);
    expect([...details.querySelectorAll("button")].map((one) => one.textContent)).toEqual(["Go to source", "Edit comment", "Close"]);
    expect(details.querySelector(".ui-button-primary")).toBeNull();
  });

  it("draws the card the same way, with Save as its one primary action", () => {
    const editor = openEditor();
    expectSharedLook(editor);
    expect([...editor.querySelectorAll(".ui-button-primary")].map((one) => one.textContent)).toEqual(["Save"]);
    expect(button(editor, "Save").disabled).toBe(false);
  });

  it("turns Save off and says why once the comment is over the limit", () => {
    const editor = openEditor();
    const field = editor.querySelector("textarea")!;
    type(field, "x".repeat(CITATION_MAX_COMMENT_LENGTH + 1));
    expect(button(editor, "Save").disabled).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(editor.querySelector('[role="status"]')!.textContent).toBe("Comments can contain up to 4,000 characters.");
    press(field, "Enter");
    expect(onChange).not.toHaveBeenCalled();

    type(field, "x".repeat(CITATION_MAX_COMMENT_LENGTH));
    expect(button(editor, "Save").disabled).toBe(false);
    expect(editor.querySelector('[role="status"]')).toBeNull();
  });

  it("closes on Escape without saving", () => {
    const editor = openEditor();
    type(editor.querySelector("textarea")!, "changed");
    press(editor.querySelector("textarea")!, "Escape");
    expect(dialog("Comment on citation")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
