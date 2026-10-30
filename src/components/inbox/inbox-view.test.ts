import { describe, expect, it } from "vitest";

import { approvalRow, inboxView, messageRow, questionRow, reportRow, settledRow } from "@/testing/inbox-fixture";
import { askOf, choiceResponse, choicesOf, closeResponse, quickActions, rowsIn, subjectOf, tabCounts } from "./inbox-view";

describe("the inbox's tabs", () => {
  it("lists each line in the one tab the server put it in, newest first, and counts them", () => {
    const view = inboxView();
    expect(rowsIn(view, "needs-you").map((row) => row.id)).toEqual([approvalRow.id, questionRow.id]);
    expect(rowsIn(view, "info").map((row) => row.id)).toEqual([messageRow.id, reportRow.id]);
    expect(rowsIn(view, "done").map((row) => row.id)).toEqual([settledRow.id]);
    expect(tabCounts(view)).toEqual({ "needs-you": 2, info: 2, done: 1 });
    expect(tabCounts(null)).toEqual({ "needs-you": 0, info: 0, done: 0 });
  });

  it("answers only an ask that is still open: news and a settled ask offer no answer", () => {
    expect([approvalRow, questionRow, messageRow, reportRow, settledRow].map(askOf)).toEqual(["approval", "question", null, null, null]);
  });
});

describe("a row's actions", () => {
  it("offers an approval's own answer first, a question's reply and close, news its done, anything else its chat", () => {
    expect(quickActions(approvalRow)).toEqual(["allow", "deny", "reply"]);
    expect(quickActions(questionRow)).toEqual(["reply", "close"]);
    expect(quickActions(messageRow)).toEqual(["done", "open"]);
    expect(quickActions(reportRow)).toEqual(["done", "open"]);
    expect(quickActions(settledRow)).toEqual(["open"]);
  });

  it("names each line's subject plainly, or by the conversation a message came from", () => {
    expect([approvalRow, questionRow, reportRow].map(subjectOf)).toEqual(["Approval", "Question", "Routine report"]);
    expect(subjectOf(messageRow)).toBe("Message");
    expect(subjectOf({ ...messageRow, origin: { botId: "scout", threadId: "scout-main", title: "Launch" } })).toBe("Launch");
  });

  it("taps a question's choice as its answer, in the card's own format, and closes it without one", () => {
    expect(choicesOf(questionRow)).toEqual(["Home", "Pricing"]);
    expect(choiceResponse(questionRow, "Home")).toEqual({ behavior: "answer", message: "Home" });
    const asked = { ...questionRow, card: { ...questionRow.card!, questionRequest: { version: 1 as const, questions: [{ question: "Which page?", options: [{ label: "Home" }, { label: "Pricing" }] }] } } };
    expect(choicesOf(asked)).toEqual(["Home", "Pricing"]);
    expect(choiceResponse(asked, "Pricing").message).toContain("Pricing");
    expect(closeResponse(questionRow)).toMatchObject({ behavior: "answer", dismiss: true });
    expect(closeResponse(approvalRow), "an approval closes as a deny").toMatchObject({ behavior: "deny" });
    expect(choicesOf(approvalRow)).toEqual([]);
  });
});
