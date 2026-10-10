// @vitest-environment happy-dom
// Letter keys pick options and typing your own answer replaces a single
// pick.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, type Message, type useStore } from "@/state/store";
import type { AskQuestion } from "../../shared/ask-question";
import { QuestionCard } from "./QuestionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const radios = () => Array.from(host.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]'));
const checked = () => radios().map((element) => element.getAttribute("aria-checked"));
const press = (target: Element, key: string, extra: KeyboardEventInit = {}) =>
  act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra })));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  dispatch.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const plan: AskQuestion = { question: "Which plan?", options: [{ label: "Free" }, { label: "Pro" }, { label: "Team" }] };

describe("QuestionCard keys", () => {
  it("picks the option a letter names", () => {
    // two questions, so a pick waits for submit instead of sending
    mount([plan, { ...plan, question: "Which region?" }]);
    press(radios()[0]!, "b");
    // the pick lands, and the card moves on to the question still owed
    expect(host.textContent).toContain("1 of 2 answered");
    expect(host.textContent).toContain("Which region?");
    press(radios()[0]!, "C");
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(host.textContent).toContain("2 of 2 answered");
  });

  it("leaves letters alone while typing, or with a modifier held", () => {
    mount([plan, { ...plan, question: "Which region?" }]);
    const field = host.querySelector("textarea")!;
    press(field, "a");
    press(radios()[0]!, "a", { metaKey: true });
    expect(checked()).toEqual(["false", "false", "false"]);
  });

  it("toggles checkmarks on a multi-select", () => {
    mount([{ ...plan, multiSelect: true }]);
    press(radios()[0]!, "a");
    press(radios()[0]!, "c");
    expect(checked()).toEqual(["true", "false", "true"]);
    expect(host.querySelectorAll("svg.text-accent-text").length).toBe(2);
  });

  it("ignores letters pressed on another control, such as a tab", () => {
    mount([plan, { ...plan, question: "Which region?" }]);
    const tab = host.querySelector('[role="tab"]')!;
    press(tab, "b");
    expect(checked()).toEqual(["false", "false", "false"]);
    expect(host.textContent).toContain("0 of 2 answered");
  });

  it("offers no X on a waiting question, since the server only takes an answer", () => {
    mount([plan]);
    expect(host.querySelector('button[aria-label]')).toBeNull();
  });
});
