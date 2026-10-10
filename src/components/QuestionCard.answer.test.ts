// @vitest-environment happy-dom
// Answering in one step: a single pick sends itself, and an open question
// is a text field from the start, where Enter sends and Shift+Enter breaks
// the line.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import type { AskQuestion } from "../../shared/ask-question";
import { answersInOneTap, initialDraft, QuestionCard } from "./QuestionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plan: AskQuestion = { question: "Which plan should the workspace use?", header: "Choose a plan", options: [{ label: "Free" }, { label: "Pro" }] };
const name: AskQuestion = { question: "What should the repository be called?", options: [] };
const checks: AskQuestion = { question: "Which checks?", multiSelect: true, options: [{ label: "Lint" }, { label: "Unit tests" }] };

let host: HTMLDivElement;
let root: Root;
const dispatch = vi.fn();

function mount(questions: AskQuestion[]) {
  const message = {
    id: "m1", role: "bot", kind: "options", at: 1,
    card: { title: "Your bot has a question", subtitle: questions[0]!.question, options: [], requestId: "req-1", questionRequest: { version: 1, questions } },
  } as unknown as Message;
  const store = { state: {}, dispatch } as unknown as ReturnType<typeof useStore>;
  act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(QuestionCard, { threadId: "t1", bot: { name: "Dev" }, message }) })));
}

// an option row reads "A" (its key badge) then the label, so match the
// label at the end of the text
const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find((element) => {
    const text = element.textContent?.trim() ?? "";
    return text === label || (element.hasAttribute("data-ask-choice") && text.slice(1) === label);
  })!;

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

  it("opens the text field from the start only for a question with nothing to pick", () => {
    expect(initialDraft(name).other).toBe(true);
    expect(initialDraft(plan).other).toBe(false);
  });
});

describe("QuestionCard answered in one step", () => {
  it("sends a single pick right away and folds into one line", () => {
    mount([plan]);
    expect(button("Submit answer")).toBeUndefined();
    act(() => button("Pro").click());
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "answer" });
    expect(dispatch.mock.calls[0]![0].message).toContain("A: Pro");
    expect(host.querySelector('[data-ask-card="settled"]')?.textContent).toContain("Choose a plan · Pro");
  });

  it("sends a single pick from its letter key too", () => {
    mount([plan]);
    press(host.querySelector('[role="radio"]')!, { key: "b" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].message).toContain("A: Pro");
  });

  it("waits for Submit or Enter when they type their own answer", () => {
    mount([plan]);
    const field = host.querySelector("textarea")!;
    type(field, "Enterprise");
    expect(dispatch).not.toHaveBeenCalled();
    act(() => button("Submit answer").click());
    expect(dispatch.mock.calls[0]![0].message).toContain("A: Enterprise");
  });

  it("does not send a multi-select pick on its own", () => {
    mount([checks]);
    act(() => button("Lint").click());
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers an open question in a text field: Shift+Enter breaks the line, Enter sends", () => {
    mount([name]);
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
    mount([name]);
    press(host.querySelector("textarea")!, { key: "Enter" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps options-only questions one-tap without a text field", () => {
    mount([{ ...plan, custom: false }]);
    expect(host.querySelector("textarea, input")).toBeNull();
    act(() => button("Pro").click());
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].message).toContain("A: Pro");
  });

  it("restores the choices after a failed answer so it can be retried", () => {
    mount([plan]);
    act(() => button("Pro").click());
    act(() => dispatch.mock.calls[0]![0].onError());
    expect(host.querySelector('[data-ask-card="pending"]')).not.toBeNull();
    act(() => button("Free").click());
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0].message).toContain("A: Free");
  });

  it("does not send Enter while an IME composition is active", () => {
    mount([name]);
    const field = host.querySelector("textarea")!;
    type(field, "新项目");
    press(field, { key: "Enter", isComposing: true });
    expect(dispatch).not.toHaveBeenCalled();
    press(field, { key: "Enter" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
