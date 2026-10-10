import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Bot, Message } from "@/state/store";
import type { AskQuestion, QuestionRequestCardData } from "../../shared/ask-question";

// The card dispatches its answer through the store, and the store module
// touches window/localStorage at import time — same shape as
// ModelPicker.test.ts, which renders a store-backed component under the
// "node" environment.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch }),
}));

const { QuestionCard, choiceIndexForKey, choiceKey, settledQuestionLine } = await import("./QuestionCard");

afterAll(() => vi.unstubAllGlobals());

const questionRequest: QuestionRequestCardData = {
  version: 1,
  questions: [
    {
      question: "Which model should Hazelnut run on by default?",
      header: "Model",
      options: [
        { label: "Claude Opus 5", description: "What the bot had before." },
        { label: "OpenAI Codex / GPT", description: "Reads AGENTS.md and .codex/skills." },
      ],
    },
    {
      question: "Which style should it write in?",
      header: "Style",
      options: [{ label: "Terse" }, { label: "Chatty" }],
    },
  ],
};

const bot = { id: "bot-1", name: "Hazelnut" } as Bot;

function message(card: Partial<Message["card"]> = {}): Message {
  return {
    id: "m-1",
    role: "bot",
    kind: "options",
    at: "2026-09-08T10:00:00.000Z",
    card: {
      title: "Your bot has a question",
      subtitle: "Which model should Hazelnut run on by default?",
      options: [],
      requestId: "req-1",
      questionRequest,
      ...card,
    },
  } as unknown as Message;
}

const render = (m: Message) =>
  renderToStaticMarkup(createElement(QuestionCard, { threadId: "thread-1", bot, message: m }));

describe("QuestionCard", () => {
  it("offers the full question when the ask is long", () => {
    const question = "Quick onboarding check. ".repeat(20);
    const markup = render(message({
      questionRequest: {
        version: 1,
        questions: [{ question, options: [] }],
      },
    }));
    expect(markup).toContain("Show full question");
    expect(markup).toContain("line-clamp-4");
    expect(markup).toContain(question);
  });

  it("shows the model's own question and options instead of an approval", () => {
    const markup = render(message());
    expect(markup).toContain("Hazelnut has a question");
    expect(markup).toContain("Which model should Hazelnut run on by default?");
    expect(markup).toContain("Claude Opus 5");
    expect(markup).toContain("What the bot had before.");
    // the three words that made this card wrong in the first place
    expect(markup).not.toContain("Always allow");
    expect(markup).not.toContain("Allow once");
    expect(markup).not.toContain(">Deny<");
  });

  it("badges an agent-composed ask, and only one", () => {
    expect(render(message({ questionRequest: { ...questionRequest, origin: "output" } }))).toContain("Agent-composed question");
    expect(render(message())).not.toContain("Agent-composed question");
  });

  it("gives every question a tab and offers free text as well", () => {
    const markup = render(message());
    expect(markup).toContain("Model");
    expect(markup).toContain("Style");
    expect(markup).toContain("0 of 2 answered");
    expect(markup).toContain('placeholder="Type your own answer"');
  });

  it("offers no free text on an options-only question", () => {
    const markup = render(message({
      questionRequest: { version: 1, questions: [{ question: "Which article?", custom: false, options: [{ label: "Machines of Loving Grace" }, { label: "Reasoning models" }] }] },
    }));
    expect(markup).toContain("Machines of Loving Grace");
    expect(markup).not.toContain(">Other<");
  });

  it("cannot be submitted before every question is answered", () => {
    expect(render(message())).toContain("disabled");
  });

  it("is a radio group per question, and a checkbox group when multiSelect", () => {
    expect(render(message())).toContain('role="radiogroup"');
    const multi = message({
      questionRequest: {
        version: 1,
        questions: [{ question: "Which stores?", multiSelect: true, options: [{ label: "Instamart" }] }],
      },
    });
    expect(render(multi)).toContain('role="checkbox"');
  });

  it("shows what was answered once the card is settled, not the buttons again", () => {
    const markup = render(
      message({ answered: "answer", answeredText: "The user answered your questions.\n\nQ: Which model?\nA: Claude Opus 5" }),
    );
    expect(markup).toContain("A: Claude Opus 5");
    expect(markup).not.toContain('role="radiogroup"');
  });

  it("makes a short single question the title, in plain ink", () => {
    const single = message({ questionRequest: { version: 1, questions: [questionRequest.questions[1]!] } });
    const markup = render(single);
    expect(markup).toMatch(/text-\[15px\] font-semibold leading-6 text-ink"><bdi dir="auto">Which style should it write in\?</);
    expect(markup).not.toContain("text-accent-text\"><bdi");
  });

  it("puts the options in one rounded group, each keyed by a letter", () => {
    const question = { question: "Which article?", options: [{ label: "A new analytical piece on reasoning models and what they change" }, { label: "Chip race" }, { label: "Blackwell" }] };
    const markup = render(message({ questionRequest: { version: 1, questions: [question] } }));
    expect(markup).toContain("divide-y divide-ink/[0.12] overflow-hidden rounded-2xl border border-ink/[0.12]");
    expect(markup).toMatch(/role="radio" aria-checked="false" aria-keyshortcuts="A" class=/);
    expect(markup).toMatch(/aria-keyshortcuts="C"/);
    expect(markup).toMatch(/rounded-md text-\[12px\] font-medium[^"]*">A</);
    expect(markup).toMatch(/break-words text-\[15px\] leading-6 text-ink \[unicode-bidi:plaintext\]">A new analytical piece/);
    // no radio circles and a separate field under the group
    expect(markup).not.toContain("rounded-full border-");
    expect(markup).toContain('placeholder="Type your own answer"');
  });

  it("maps letter keys to options and ignores anything else", () => {
    expect([0, 1, 2, 25].map(choiceKey)).toEqual(["A", "B", "C", "Z"]);
    expect(choiceIndexForKey("a", 3)).toBe(0);
    expect(choiceIndexForKey("C", 3)).toBe(2);
    expect(choiceIndexForKey("d", 3)).toBe(-1);
    expect(choiceIndexForKey("Enter", 3)).toBe(-1);
    expect(choiceIndexForKey("1", 3)).toBe(-1);
  });

  it("offers no free text on an options-only question", () => {
    const markup = render(message({
      questionRequest: { version: 1, questions: [{ question: "Which article?", custom: false, options: [{ label: "Machines of Loving Grace" }, { label: "Reasoning models" }] }] },
    }));
    expect(markup).toContain("Machines of Loving Grace");
    expect(markup).not.toContain("Type your own answer");
  });

  it("folds an answered card into one line, with the full answer behind Details", () => {
    const markup = render(message({
      answered: "answer",
      answeredText: "The user answered your questions.\n\nQ: Which model should Hazelnut run on by default?\nA: Claude Opus 5\n\nQ: Which style should it write in?\nA: Terse",
    }));
    expect(markup).toContain('data-ask-card="settled"');
    expect(markup).toContain("Model: Claude Opus 5 · Style: Terse");
    expect(markup).toContain("Details");
    expect(markup).not.toContain("Submit");
    expect(markup).not.toContain("The user answered your questions.");
  });

  it("says a question nobody answered was closed, not answered", () => {
    const markup = render(message({ answered: "unavailable" }));
    expect(markup).toContain("Closed without an answer");
    expect(markup).not.toContain('role="radiogroup"');
    expect(markup).not.toContain("Details");
  });

  it("renders nothing for a card that carries no questions", () => {
    expect(render(message({ questionRequest: undefined }))).toBe("");
  });
});

describe("settledQuestionLine", () => {
  const [model, style] = questionRequest.questions as [AskQuestion, AskQuestion];

  it("names one question by its header and shows only the answer", () => {
    expect(settledQuestionLine([model], "The user answered your questions.\n\nQ: Which model should Hazelnut run on by default?\nA: Claude Opus 5"))
      .toEqual({ label: "Model", value: "Claude Opus 5" });
  });

  it("falls back to the question text when there is no header", () => {
    const plain = { question: "Which store?", options: [] };
    expect(settledQuestionLine([plain], "Instamart")).toEqual({ label: "Which store?", value: "Instamart" });
  });

  it("lists each header beside its answer for a set, on one line", () => {
    const line = settledQuestionLine([model, style], "Q: Which model should Hazelnut run on by default?\nA: Claude\nOpus\n\nQ: Which style should it write in?\nA: Terse");
    expect(line.value).toBe("Model: Claude Opus · Style: Terse");
  });

  it("says Answered when there is no text to show", () => {
    expect(settledQuestionLine([model], undefined)).toEqual({ label: "Answered", value: "" });
  });
});
