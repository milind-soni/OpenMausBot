import { describe, expect, it } from "vitest";
import type { AskQuestion } from "./ask-question";
import type { OptionCardData } from "./wire";
import { channelQuestions, formatChannelApproval, formatChannelQuestion, isChannelReviewCard, parseChannelQuestionReply } from "./channel-replies";

const question: AskQuestion = {
  question: "Which release should I prepare?",
  options: [{ label: "Stable", description: "Use the tested release." }, { label: "Preview", description: "Try the newest changes." }],
};
const card: OptionCardData = { title: "Release", subtitle: question.question, options: ["Stable", "Preview"], requestId: "req-1" };
const permission: OptionCardData = {
  title: "Run the release command?", subtitle: "Publish the reviewed package.\nAll requested details remain visible.",
  options: ["Deny", "Allow once", "Always allow"], requestType: "permission", tool: "Bash", requestId: "req-2",
  commandAllowlist: { command: "npm publish --tag next", cwd: "/workspace/release", providerInstanceId: "provider-1" },
};

describe("channel question content", () => {
  it("uses the structured questions instead of a summary or approval options", () => {
    expect(channelQuestions({ ...permission, questionRequest: { version: 1, questions: [question] } })).toEqual([question]);
  });
  it("uses the actual legacy subtitle and options", () => {
    expect(channelQuestions(card)).toEqual([{ question: question.question, options: [{ label: "Stable" }, { label: "Preview" }] }]);
    expect(channelQuestions({ ...card, subtitle: "", options: [] })).toEqual([{ question: "Release", options: [] }]);
  });
  it("keeps explicit free-text question cards with a tool", () => {
    expect(channelQuestions({ ...card, requestType: "question", tool: "ask_user", options: [] })).toEqual([{ question: question.question, options: [] }]);
  });
  it("does not turn permissions or malformed structured questions into invented questions", () => {
    expect(channelQuestions(permission)).toBeNull();
    expect(channelQuestions({ ...card, questionRequest: { version: 1, questions: [] } })).toBeNull();
    expect(channelQuestions({ ...card, title: "", subtitle: "" })).toBeNull();
  });
  it.each(["profileRequest", "modelRequest", "routineRequest", "skillRequest", "teamSetupRequest", "teamMemoryRequest"])("leaves %s for app review even with question metadata", (field) => {
    const review = { ...card, [field]: {}, questionRequest: { version: 1, questions: [question] } } as OptionCardData;
    expect(isChannelReviewCard(review)).toBe(true);
    expect(channelQuestions(review)).toBeNull();
    expect(formatChannelApproval(review, "A1B2")).toBeNull();
  });
  it("does not classify ordinary permissions or questions as app reviews", () => {
    expect(isChannelReviewCard(card)).toBe(false);
    expect(isChannelReviewCard(permission)).toBe(false);
  });
  it("sends the complete question, numbered options and descriptions without exposing internal answer codes", () => {
    const output = formatChannelQuestion(question, "A1B2", 0, 2);
    expect(output).toContain("Question 1 of 2");
    expect(output).toContain(question.question);
    expect(output).toContain("1. Stable");
    expect(output).toContain("Use the tested release.");
    expect(output).toContain("2. Preview");
    expect(output).toContain("Try the newest changes.");
    expect(output).not.toMatch(/A1B2|ANSWER|Request code/);
    expect(output).toMatch(/own words/i);
    expect(output).not.toContain("Always allow");
  });
  it("explains multi-selection and preserves long question text", () => {
    const output = formatChannelQuestion({ ...question, question: "Long context. ".repeat(500), multiSelect: true }, "A1B2", 1, 2);
    expect(output).toContain("Long context. ".repeat(500).trim());
    expect(output).toContain("1,2");
    expect(output).toContain("Question 2 of 2");
  });
  it("does not fabricate options or numeric instructions for a free-text question", () => {
    const output = formatChannelQuestion({ question: "What is the release name?", options: [] }, "", 0, 1);
    expect(output).toContain("What is the release name?");
    expect(output).toMatch(/own words/i);
    expect(output).not.toMatch(/1\.|ANSWER|number/i);
  });
});

describe("channel question replies", () => {
  it.each([
    ["1", ["Stable"]], [" 2 ", ["Preview"]], ["Stable", ["Stable"]],
    ["Wait until Friday", ["Wait until Friday"]], ["ANSWER A1B2 2", ["Preview"]],
    ["answer a1b2 Wait until Friday", ["Wait until Friday"]],
  ])("parses %s", (input, answers) => {
    expect(parseChannelQuestionReply(question, input as string, "A1B2")).toEqual({ answers });
  });
  it("accepts bounded custom text and preserves its internal line breaks", () => {
    expect(parseChannelQuestionReply(question, "a".repeat(2000), "A1B2")).toEqual({ answers: ["a".repeat(2000)] });
    expect(parseChannelQuestionReply(question, "Friday\nafter lunch", "A1B2")).toEqual({ answers: ["Friday\nafter lunch"] });
  });
  it.each(["", "   ", "0", "3", "99999999999999999999", "-1", "1,2", "ANSWER WRONG 1", "ANSWER A1B2", "a".repeat(2001)])("rejects invalid or ambiguous reply %s", (input) => {
    expect(parseChannelQuestionReply(question, input, "A1B2")).toHaveProperty("error");
  });
  it("maps multiple numeric selections to the actual labels and deduplicates them", () => {
    expect(parseChannelQuestionReply({ ...question, multiSelect: true }, "2, 1, 2", "A1B2")).toEqual({ answers: ["Preview", "Stable"] });
  });
  it("rejects a multiple selection containing an invalid option", () => {
    expect(parseChannelQuestionReply({ ...question, multiSelect: true }, "1,3", "A1B2")).toHaveProperty("error");
  });
  it("allows numeric free text when a question has no choices", () => {
    expect(parseChannelQuestionReply({ question: "How many?", options: [] }, "42", "A1B2")).toEqual({ answers: ["42"] });
  });
  it("accepts an exact numeric option label instead of treating it as an out-of-range index", () => {
    expect(parseChannelQuestionReply({ question: "Which year?", options: [{ label: "2025" }, { label: "2026" }] }, "2026", "A1B2")).toEqual({ answers: ["2026"] });
  });
});

describe("channel approval content", () => {
  it("includes the outbound app and every call in a request-specific approval", () => {
    const outbound: OptionCardData = { ...permission, outboundRequest: {
      tool: "send_messages", app: "Messages", calls: [{ app: "Messages", label: "Send release note to Alex" }, { app: "Mail", label: "Email release note to Jo" }, { app: null, label: "Archive the published note" }],
    } };
    expect(isChannelReviewCard(outbound)).toBe(false);
    expect(channelQuestions(outbound)).toBeNull();
    const output = formatChannelApproval(outbound, "9A8B7C6D");
    expect(output).toContain("send_messages");
    expect(output).toContain("Messages");
    expect(output).toContain("Send release note to Alex");
    expect(output).toContain("Mail");
    expect(output).toContain("Email release note to Jo");
    expect(output).toContain("Archive the published note");
    expect(output).toMatch(/yes.*approve/i);
    expect(output).not.toContain("9A8B7C6D");
    expect(output).toMatch(/no.*deny/i);
    expect(output).not.toMatch(/always allow/i);
  });
  it("refuses outbound scope that cannot fit completely in the approval message", () => {
    expect(formatChannelApproval({ ...permission, outboundRequest: { tool: "send_messages", app: null, calls: [{ app: null, label: "x".repeat(16_000) }] } }, "A1B2")).toBeNull();
  });
  it("shows the full request and command with only request-specific once/deny instructions", () => {
    const output = formatChannelApproval(permission, "A1B2");
    expect(output).toContain(permission.title);
    expect(output).toContain("Bash");
    expect(output).toContain(permission.subtitle);
    expect(output).toContain("npm publish --tag next");
    expect(output).toContain("/workspace/release");
    expect(output).toContain("approve for me");
    expect(output).not.toContain("A1B2");
    expect(output).toContain("ask me first");
    expect(output).toMatch(/once|one.time/i);
    expect(output).not.toMatch(/always allow/i);
  });
  it("refuses questions and oversized approvals instead of hiding request details", () => {
    expect(formatChannelApproval(card, "A1B2")).toBeNull();
    expect(formatChannelApproval({ ...permission, questionRequest: { version: 1, questions: [question] } }, "A1B2")).toBeNull();
    expect(formatChannelApproval({ ...permission, subtitle: "x".repeat(16_000) }, "A1B2")).toBeNull();
    expect(formatChannelApproval({ ...permission, commandAllowlist: { ...permission.commandAllowlist!, command: "x".repeat(16_000) } }, "A1B2")).toBeNull();
  });
});
