import { describe, expect, it } from "vitest";

import {
  answerWithoutPreamble,
  askQuestionSummary,
  askUserQuestionToolResult,
  formatQuestionAnswers,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  parseAskQuestions,
  questionChoices,
  type AskQuestion,
} from "./ask-question";

/** The shape Claude Code's AskUserQuestion actually sends. */
const REAL_INPUT = {
  questions: [
    {
      question: "Should I operate purely on-demand, or set up a weekly restock check?",
      header: "Schedule",
      multiSelect: false,
      options: [
        { label: "On-demand only", description: "I act when you ask." },
        { label: "Weekly restock", description: "I check your staples every Sunday." },
      ],
    },
  ],
};

describe("parseAskQuestions", () => {
  it("reads the questions out of a real tool input", () => {
    expect(parseAskQuestions(REAL_INPUT)).toEqual([
      {
        question: "Should I operate purely on-demand, or set up a weekly restock check?",
        header: "Schedule",
        options: [
          { label: "On-demand only", description: "I act when you ask." },
          { label: "Weekly restock", description: "I check your staples every Sunday." },
        ],
      },
    ]);
  });

  it("keeps multiSelect only when the model asked for it", () => {
    const [single] = parseAskQuestions(REAL_INPUT)!;
    expect(single).not.toHaveProperty("multiSelect");
    const [multi] = parseAskQuestions({
      questions: [{ question: "Which stores?", multiSelect: true, options: [{ label: "Instamart" }] }],
    })!;
    expect(multi!.multiSelect).toBe(true);
  });

  it("answers null for anything that is not a question payload", () => {
    // Every one of these reaches us as a permission ask for some OTHER tool,
    // and must keep the ordinary approval card rather than becoming a
    // question nobody can allow.
    expect(parseAskQuestions({ command: "git push" })).toBeNull();
    expect(parseAskQuestions({ questions: "tea or coffee" })).toBeNull();
    expect(parseAskQuestions({ questions: [] })).toBeNull();
    expect(parseAskQuestions({ questions: [{ header: "no question text" }] })).toBeNull();
    expect(parseAskQuestions(null)).toBeNull();
  });

  it("keeps a question whose options are missing — free text still answers it", () => {
    expect(parseAskQuestions({ questions: [{ question: "Which account?" }] })).toEqual([
      { question: "Which account?", options: [] },
    ]);
  });

  it("drops duplicate labels, which a radio group cannot express", () => {
    const [question] = parseAskQuestions({
      questions: [{ question: "Pick one", options: [{ label: "Tea" }, { label: "Tea", description: "again" }, "Coffee"] }],
    })!;
    expect(question!.options.map((option) => option.label)).toEqual(["Tea", "Coffee"]);
  });

  it("caps a runaway payload instead of rendering it", () => {
    const questions = parseAskQuestions({
      questions: Array.from({ length: MAX_QUESTIONS + 4 }, (_, index) => ({
        question: `q${index}`,
        options: Array.from({ length: MAX_OPTIONS + 5 }, (_, option) => ({ label: `o${option}` })),
      })),
    })!;
    expect(questions).toHaveLength(MAX_QUESTIONS);
    expect(questions[0]!.options).toHaveLength(MAX_OPTIONS);
  });

  it("truncates rather than trusting bot-authored lengths", () => {
    const [question] = parseAskQuestions({
      questions: [{ question: "x".repeat(9000), options: [{ label: "y".repeat(9000) }] }],
    })!;
    expect(question!.question.length).toBeLessThanOrEqual(400);
    expect(question!.options[0]!.label.length).toBeLessThanOrEqual(120);
  });
});

describe("askQuestionSummary", () => {
  const questions = parseAskQuestions({
    questions: [
      { question: "Which model?", options: [] },
      { question: "Which style?", options: [] },
      { question: "Which platform?", options: [] },
    ],
  })!;

  it("leads with the first question and counts the rest", () => {
    expect(askQuestionSummary(questions)).toBe("Which model? (+2 more questions)");
    expect(askQuestionSummary(questions.slice(0, 2))).toBe("Which model? (+1 more question)");
    expect(askQuestionSummary(questions.slice(0, 1))).toBe("Which model?");
  });
});

describe("questionChoices", () => {
  it("offers flat labels for a single-choice question, so older clients can answer", () => {
    expect(questionChoices(parseAskQuestions(REAL_INPUT)!)).toEqual(["On-demand only", "Weekly restock"]);
  });

  it("offers none when a flat list would lose which question was answered", () => {
    const two = parseAskQuestions({
      questions: [
        { question: "Which model?", options: [{ label: "Opus" }, { label: "Sonnet" }] },
        { question: "Which style?", options: [{ label: "Terse" }, { label: "Chatty" }] },
      ],
    })!;
    expect(questionChoices(two)).toBeUndefined();
    // …and none for multi-select, where one tap is not the whole answer
    const multi = parseAskQuestions({
      questions: [{ question: "Which stores?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }],
    })!;
    expect(questionChoices(multi)).toBeUndefined();
  });
});

describe("formatQuestionAnswers", () => {
  const questions: AskQuestion[] = [
    { question: "Which model?", options: [{ label: "Opus" }] },
    { question: "Which stores?", multiSelect: true, options: [{ label: "Instamart" }] },
  ];

  it("names each question beside its answer — the model sees only this text", () => {
    expect(formatQuestionAnswers(questions, [["Opus"], ["Instamart", "Blinkit"]])).toBe(
      "The user answered your questions.\n\nQ: Which model?\nA: Opus\n\nQ: Which stores?\nA: Instamart, Blinkit",
    );
  });

  it("omits a question that was left unanswered instead of implying one", () => {
    expect(formatQuestionAnswers(questions, [["Opus"], ["  "]])).toBe(
      "The user answered your questions.\n\nQ: Which model?\nA: Opus",
    );
  });

  it("is empty when nothing was answered, so nothing is sent", () => {
    expect(formatQuestionAnswers(questions, [[], []])).toBe("");
  });
});

describe("answerWithoutPreamble", () => {
  it("drops the model-facing lead-in the card should not repeat", () => {
    const answer = formatQuestionAnswers([{ question: "Which model?", options: [] }], [["Opus"]]);
    expect(answerWithoutPreamble(answer)).toBe("Q: Which model?\nA: Opus");
  });

  it("leaves anything else alone", () => {
    expect(answerWithoutPreamble("Tea")).toBe("Tea");
  });
});

describe("askUserQuestionToolResult", () => {
  it("delivers the answer on the deny channel — the only one the CLI passes through", () => {
    // Pinned deliberately: "allow" here looks more natural and silently
    // loses the answer ("The user did not answer the questions").
    expect(JSON.parse(askUserQuestionToolResult("The user answered: Opus"))).toEqual({
      behavior: "deny",
      message: "The user answered: Opus",
    });
  });
});
