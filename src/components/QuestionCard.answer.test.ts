// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import type { AskQuestion } from "../../shared/ask-question";
import { answersInOneTap, QuestionCard } from "./QuestionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plan: AskQuestion = { question: "Which plan should the workspace use?", header: "Choose a plan", options: [{ label: "Free" }, { label: "Pro" }] };
const name: AskQuestion = { question: "What should the repository be called?", options: [] };
const checks: AskQuestion = { question: "Which checks?", multiSelect: true, options: [{ label: "Lint" }, { label: "Unit tests" }] };

let host: HTMLDivElement;
let root: Root;
const dispatch = vi.fn();

const card = (questions: AskQuestion[], over: Partial<NonNullable<Message["card"]>> = {}) => ({
  id: "m1", role: "bot", kind: "options", at: 1,
  card: { title: "Your bot has a question", subtitle: questions[0]!.question, options: [], requestId: "req-1", requestType: "question", questionRequest: { version: 1, questions }, ...over },
}) as unknown as Message;

function mount(message: Message) {
  const store = { state: { bots: [] }, dispatch } as unknown as ReturnType<typeof useStore>;
  act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(QuestionCard, { threadId: "t1", asker: { name: "Dev", color: "teal" }, message }) })));
}

const button = (label: string) => Array.from(host.querySelectorAll("button")).find((element) => element.textContent?.trim() === label);
const choice = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("[data-ask-choice]")).find((element) => element.textContent?.trim() === label)!;

function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(field: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  dispatch.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("answersInOneTap", () => {
  it("is only one single-select question with options", () => {
    expect(answersInOneTap([plan])).toBe(true);
    expect(answersInOneTap([plan, plan])).toBe(false);
    expect(answersInOneTap([checks])).toBe(false);
    expect(answersInOneTap([name])).toBe(false);
  });
});

describe("QuestionCard answered in one step", () => {
  it("sends a pick at once, shows it on its way while the others wait, and settles when it lands", () => {
    mount(card([plan]));
    expect(button("Submit answer")).toBeUndefined();
    act(() => choice("Pro").click());
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ type: "decideRequest", threadId: "t1", requestId: "req-1", behavior: "answer" });
    expect(dispatch.mock.calls[0]![0].message).toContain("A: Pro");
    expect(choice("Pro").getAttribute("aria-busy")).toBe("true");
    expect(choice("Free").disabled).toBe(true);
    act(() => choice("Free").click());
    expect(dispatch, "one answer at a time").toHaveBeenCalledTimes(1);
    mount(card([plan], { answered: "answer", answeredText: "The user answered your questions.\n\nQ: Which plan should the workspace use?\nA: Pro" }));
    expect(host.querySelector('[data-ask-card="settled"]')?.textContent).toContain("You chose: Pro");
  });

  it("takes no letter key: a choice is pressed", () => {
    mount(card([plan]));
    press(host.querySelector('[role="radio"]')!, { key: "b" });
    press(host.querySelector('[data-ask-card="pending"]')!, { key: "a" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("sends the person's own words from Something else on Enter", () => {
    mount(card([plan]));
    const field = host.querySelector("textarea")!;
    type(field, "Enterprise");
    expect(dispatch).not.toHaveBeenCalled();
    press(field, { key: "Enter" });
    expect(dispatch.mock.calls[0]![0].message).toContain("A: Enterprise");
  });

  it("collects several picks and sends them with Done", () => {
    mount(card([checks]));
    act(() => choice("Lint").click());
    act(() => choice("Unit tests").click());
    expect(dispatch).not.toHaveBeenCalled();
    act(() => button("Done")!.click());
    expect(dispatch.mock.calls[0]![0].message).toContain("A: Lint, Unit tests");
  });

  it("answers an open question in a text field: Shift+Enter breaks the line, Enter sends", () => {
    mount(card([name]));
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    const field = host.querySelector("textarea")!;
    expect(field.getAttribute("dir")).toBe("auto");
    type(field, "omb-preview");
    press(field, { key: "Enter", shiftKey: true });
    expect(dispatch).not.toHaveBeenCalled();
    press(field, { key: "Enter" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].message).toContain("A: omb-preview");
  });

  it("sends nothing from an empty open question", () => {
    mount(card([name]));
    press(host.querySelector("textarea")!, { key: "Enter" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps options-only questions one-tap without a text field", () => {
    mount(card([{ ...plan, custom: false }]));
    expect(host.querySelector("textarea, input")).toBeNull();
    act(() => choice("Pro").click());
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("says when an answer did not go, and takes another", () => {
    mount(card([plan]));
    act(() => choice("Pro").click());
    act(() => dispatch.mock.calls[0]![0].onError());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't send your answer. Try again.");
    expect(choice("Free").disabled).toBe(false);
    act(() => choice("Free").click());
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0].message).toContain("A: Free");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("sends ask_user's plain pick as the label itself", () => {
    mount(card([plan], { questionRequest: undefined, subtitle: "Should I?", options: ["Yes, only the footer text", "No"] }));
    act(() => choice("Yes, only the footer text").click());
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ type: "decideRequest", behavior: "answer", message: "Yes, only the footer text" });
  });

  it("does not send Enter while an IME composition is active", () => {
    mount(card([name]));
    const field = host.querySelector("textarea")!;
    type(field, "新项目");
    press(field, { key: "Enter", isComposing: true });
    expect(dispatch).not.toHaveBeenCalled();
    press(field, { key: "Enter" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
