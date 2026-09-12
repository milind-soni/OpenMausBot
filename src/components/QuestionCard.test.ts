import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Bot, Message } from "@/state/store";
import type { QuestionRequestCardData } from "../../shared/ask-question";

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

const { QuestionCard } = await import("./QuestionCard");

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

  it("gives every question a tab and offers free text as well", () => {
    const markup = render(message());
    expect(markup).toContain("Model");
    expect(markup).toContain("Style");
    expect(markup).toContain("0 of 2 answered");
    expect(markup).toContain("Other");
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

  it("renders nothing for a card that carries no questions", () => {
    expect(render(message({ questionRequest: undefined }))).toBe("");
  });
});
