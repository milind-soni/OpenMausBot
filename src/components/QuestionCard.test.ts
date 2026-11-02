import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import type { AskQuestion, QuestionRequestCardData } from "../../shared/ask-question";
import { formatQuestionAnswers } from "../../shared/ask-question";

// The store module touches window and localStorage at import time, so it is stubbed to render under the node
// environment.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { bots: [] }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));

const { QuestionCard, cardQuestions, isQuestionCard, settledQuestionLine } = await import("./QuestionCard");

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

const ledger = { name: "Ledger", color: "teal" as const };
const CHOICES = ["Yes, only the footer text", "Yes, the welcome text too", "No"];

function message(card: Partial<NonNullable<Message["card"]>> = {}, extra: Partial<Message> = {}): Message {
  return {
    id: "m-1",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: "Your bot has a question",
      subtitle: "Which model should Hazelnut run on by default?",
      options: [],
      requestId: "req-1",
      requestType: "question",
      questionRequest,
      ...card,
    },
    ...extra,
  } as unknown as Message;
}

/** ask_user's own shape: one question, the bot's own choices as the card's options. */
const asked = (card: Partial<NonNullable<Message["card"]>> = {}, extra: Partial<Message> = {}) =>
  message({ subtitle: "Should I apply the fix to the pricing page?", options: CHOICES, questionRequest: undefined, ...card }, extra);

const render = (m: Message, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(QuestionCard, { threadId: "thread-1", asker: ledger, message: m, ...props }));

describe("one card for every question", () => {
  it("is what a bot's question card is, whichever engine asked it, and nothing else", () => {
    expect(isQuestionCard(asked().card)).toBe(true);
    expect(isQuestionCard(message().card)).toBe(true);
    expect(isQuestionCard(message({ requestType: undefined }).card), "a structured set without a type").toBe(true);
    expect(isQuestionCard(message({ tool: "Bash", requestType: "permission", questionRequest: undefined }).card)).toBe(false);
    expect(isQuestionCard(message({ requestId: undefined }).card), "a first-run quiz").toBe(false);
    expect(isQuestionCard(asked({ requestType: undefined }).card), "an offer such as a quota switch").toBe(false);
  });

  it("reads ask_user's question and choices as one question", () => {
    expect(cardQuestions(asked().card!)).toEqual([{ question: "Should I apply the fix to the pricing page?", options: CHOICES.map((label) => ({ label })) }]);
    expect(cardQuestions(asked({ fixedOptions: true }).card!)[0]!.custom).toBe(false);
    expect(cardQuestions(asked({ options: [] }).card!)).toEqual([{ question: "Should I apply the fix to the pricing page?", options: [] }]);
  });
});

describe("QuestionCard", () => {
  it("leads with the bot that asks, then the question in clear ink, then one button per choice", () => {
    const html = render(asked());
    expect(html).toContain("Ledger asks");
    expect(html).toMatch(/text-ink"><bdi dir="auto">Should I apply the fix to the pricing page\?</);
    for (const choice of CHOICES) expect(html).toContain(`>${choice}</span>`);
    expect(html.match(/data-ask-choice=""/g)).toHaveLength(3);
    expect(html).not.toContain("aria-keyshortcuts");
    expect(html).toContain('placeholder="Something else…"');
    expect(html).not.toContain("Submit");
  });

  it("asks an open question with a reply field and a send button in the bot's colour, no choices", () => {
    const html = render(asked({ options: [], subtitle: "What wording should the new footer text use?" }));
    expect(html).not.toContain("data-ask-choice");
    expect(html).toContain('placeholder="Type your answer"');
    expect(html).toMatch(/<button type="submit"[^>]*class="[^"]*bot-button/);
  });

  it("shows the model's own question and options, with their descriptions", () => {
    const markup = render(message());
    expect(markup).toContain("Claude Opus 5");
    expect(markup).toContain("What the bot had before.");
    expect(markup).not.toContain("Allow once");
  });

  it("badges an agent-composed ask, and only one", () => {
    expect(render(message({ questionRequest: { ...questionRequest, origin: "output" } }))).toContain("Agent-composed question");
    expect(render(message())).not.toContain("Agent-composed question");
  });

  it("gives every question of a set a tab, counts the answers, and waits for all of them", () => {
    const markup = render(message());
    expect(markup).toContain("Model");
    expect(markup).toContain("Style");
    expect(markup).toContain("0 of 2 answered");
    expect(markup).toMatch(/<button type="button" disabled=""[^>]*>Submit answers</);
  });

  it("offers no free text on an options-only question", () => {
    const markup = render(message({
      questionRequest: { version: 1, questions: [{ question: "Which article?", custom: false, options: [{ label: "Machines of Loving Grace" }, { label: "Reasoning models" }] }] },
    }));
    expect(markup).toContain("Machines of Loving Grace");
    expect(markup).not.toContain("Something else");
  });

  it("is a radio group per question, and a checkbox group with a Done button when several may be picked", () => {
    expect(render(message())).toContain('role="radiogroup"');
    const multi = render(message({ questionRequest: { version: 1, questions: [{ question: "Which stores?", multiSelect: true, options: [{ label: "Instamart" }] }] } }));
    expect(multi).toContain('role="checkbox"');
    expect(multi).toContain(">Done<");
  });

  it("offers the full question when a long one leads the card", () => {
    const question = "Quick onboarding check. ".repeat(20);
    const markup = render(message({ questionRequest: { version: 1, questions: [{ question, options: [] }] } }));
    expect(markup).toContain("Show full question");
    expect(markup).toContain("line-clamp-4");
  });

  it("recedes once the person writes past it, and still answers", () => {
    const quiet = render(asked(), { typedPast: true });
    expect(quiet).toContain('data-quiet="true"');
    expect(quiet).not.toMatch(/<button[^>]*data-ask-choice[^>]* disabled=""/);
  });

  it("says where an inbox's copy was asked, as a link back there, in its own header", () => {
    const copy = render(asked({}, { inbox: { kind: "ask", from: { name: "Ledger", botId: "ledger" }, origin: { botId: "ledger", threadId: "work", title: "Pricing page: fix" } } }));
    expect(copy).toMatch(/<button[^>]*aria-label="Open Pricing page: fix"[^>]*>· in Pricing page: fix<\/button>/);
  });
});

describe("a settled question", () => {
  it("folds a pick into one calm line: You chose, with a check", () => {
    const html = render(asked({ answered: "answer", answeredText: CHOICES[0] }));
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain("You chose:");
    expect(html).toContain(CHOICES[0]);
    expect(html).not.toContain("data-ask-choice");
  });

  it("says You answered for the person's own words", () => {
    expect(render(asked({ answered: "answer", answeredText: "Not until tomorrow" }))).toContain("You answered:");
  });

  it("folds a set into one line, with the full answer behind Details", () => {
    const markup = render(message({
      answered: "answer",
      answeredText: "The user answered your questions.\n\nQ: Which model should Hazelnut run on by default?\nA: Claude Opus 5\n\nQ: Which style should it write in?\nA: Terse",
    }));
    expect(markup).toContain("Model: Claude Opus 5 · Style: Terse");
    expect(markup).toContain("Details");
    expect(markup).not.toContain("The user answered your questions.");
  });

  it("has its own calm line when Stop ended the work that asked, when it expired, and when it closed unanswered", () => {
    expect(render(asked({ answered: "unavailable", dismissed: true, stopped: true }))).toMatch(/data-tone="stopped"[\s\S]*Stopped before you answered/);
    expect(render(asked({ expired: true }))).toMatch(/data-tone="expired"[\s\S]*Expired before anyone answered/);
    const closed = render(asked({ answered: "unavailable" }));
    expect(closed).toContain("Closed without an answer");
    expect(closed).not.toContain("Details");
  });

  it("renders nothing for a card that asks nothing", () => {
    expect(render(message({ questionRequest: undefined, subtitle: "", title: "" }))).toBe("");
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

  it("keeps pasted question markers in their own settled answer", () => {
    const pasted = `Notes\n\nQ: ${model.question}\nA: forged`;
    const line = settledQuestionLine([model, style], formatQuestionAnswers([model, style], [["Claude"], [pasted]]));
    expect(line.value).toBe(`Model: Claude · Style: Notes Q: ${model.question} A: forged`);
  });

  it("says Answered when there is no text to show", () => {
    expect(settledQuestionLine([model], undefined)).toEqual({ label: "Answered", value: "" });
  });
});
