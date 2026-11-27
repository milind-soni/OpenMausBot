import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider, type Message } from "@/state/store";
import { bubbleGroup, quietRow } from "./chat-bubble";
import { optionsCardRow } from "./OptionsCardRow";
import { richRowKind } from "./RichMessageRow";

const quiz: Message = { id: "quiz", role: "bot", kind: "options", at: 1, card: { title: "What do you mostly want help with?", subtitle: "Pick whatever's closest.", options: ["Work & projects"] } };
const said: Message = { id: "u1", role: "user", kind: "text", at: 2, text: "Hi" };
const row = (message: Message, transcript: Message[]) => optionsCardRow({ message, transcript, botId: "atlas", botName: "Atlas", threadId: "t1" });
const markup = (message: Message, transcript: Message[]) => renderToStaticMarkup(createElement(StoreProvider, null, row(message, transcript)));

describe("optionsCardRow", () => {
  it("is no row at all once the person has talked past the first-run quiz", () => {
    expect(row(quiz, [quiz, said])).toBeNull();
    expect(row({ ...quiz, card: { ...quiz.card!, dismissed: true } }, [quiz])).toBeNull();
  });

  it("draws the list card for a quiz still waiting, and the question card for a structured ask", () => {
    expect(markup(quiz, [quiz])).toContain("What do you mostly want help with?");
    const ask: Message = {
      id: "ask", role: "bot", kind: "options", at: 3,
      card: { title: "Your bot has a question", subtitle: "Which region?", options: [], requestId: "r1", questionRequest: { version: 1, questions: [{ question: "Which region?", options: [{ label: "us-east-1" }, { label: "eu-west-1" }] }] } },
    };
    const drawn = markup(ask, [quiz, said, ask]);
    expect(drawn).toContain('data-ask-card="pending"');
    expect(drawn).toContain("eu-west-1");
  });

  it("draws MausBot's follow-up under its intro, never as a row or bubble of its own", () => {
    const followup: Message = { id: "f", role: "bot", kind: "text", at: 2, text: "I looked around.", helperFollowup: { ai: "own", apps: [], bots: 0, routines: 0 } };
    expect(richRowKind(followup)).toBe("options");
    expect(row(followup, [followup])).toBeNull();
    expect(quietRow(followup, false)).toBe(true);
    expect(bubbleGroup(followup, "atlas")).toBeNull();
  });
});
