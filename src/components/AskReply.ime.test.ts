// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InboxRow } from "../../shared/inbox";
import { AskReply } from "./AskCard";
import { InboxQuestionAnswer } from "./inbox/InboxQuestionAnswer";

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
});

function press(field: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  flushSync(() => field.dispatchEvent(event));
  return event;
}

function type(field: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
}

const IME = [
  { name: "composition", init: { isComposing: true } },
  { name: "IME key code", init: { keyCode: 229 } },
];

describe("answering a bot's question with an input method", () => {
  function renderReply() {
    const onSend = vi.fn();
    flushSync(() => root.render(createElement(AskReply, { label: "Answer", placeholder: "Answer", color: undefined, onSend, value: "ni hao", onChange: () => {} })));
    return { field: host.querySelector("textarea")!, onSend };
  }

  it.each(IME)("AskReply leaves the Enter that belongs to the $name to the input method", ({ init }) => {
    const { field, onSend } = renderReply();
    const event = press(field, init);
    expect(event.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("AskReply still sends on a plain Enter", () => {
    const { field, onSend } = renderReply();
    press(field);
    expect(onSend).toHaveBeenCalledWith("ni hao");
  });

  function renderInbox() {
    const onAnswer = vi.fn();
    const row = { id: "row-1" } as unknown as InboxRow;
    flushSync(() => root.render(createElement(InboxQuestionAnswer, { row, question: { question: "Which branch?", options: [] }, onAnswer })));
    const field = host.querySelector("textarea")!;
    type(field, "ni hao");
    return { field, onAnswer };
  }

  it.each(IME)("the inbox answer leaves the Enter that belongs to the $name to the input method", ({ init }) => {
    const { field, onAnswer } = renderInbox();
    const event = press(field, init);
    expect(event.defaultPrevented).toBe(false);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("the inbox answer still sends on a plain Enter", () => {
    const { field, onAnswer } = renderInbox();
    press(field);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][0]).toMatchObject({ behavior: "answer", message: "ni hao" });
  });
});
