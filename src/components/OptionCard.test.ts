import { describe, expect, it } from "vitest";

import { shouldHideOnboardingCard } from "./OptionCard";
import type { Message } from "@/state/store";

const msg = (partial: Partial<Message> & Pick<Message, "id" | "kind">): Message => ({
  role: "bot",
  at: 1,
  ...partial,
});

describe("shouldHideOnboardingCard", () => {
  const quiz = msg({
    id: "quiz",
    kind: "options",
    card: {
      title: "What do you mostly want help with?",
      subtitle: "Pick whatever's closest; we can always expand from there.",
      options: ["Work & projects"],
    },
  });
  const greeting = msg({ id: "hi", kind: "text", text: "Hey — I'm Echo." });
  const user = msg({ id: "u1", role: "user", kind: "text", text: "Hi bro" });

  it("keeps the quiz until the person talks", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz])).toBe(false);
  });

  it("hides once a later user message is on the path", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz, user])).toBe(true);
  });

  it("hides an answered or dismissed quiz even with no later user message", () => {
    expect(
      shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, answered: "Work & projects" } }, [greeting, quiz]),
    ).toBe(true);
    expect(
      shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, dismissed: true } }, [greeting, quiz]),
    ).toBe(true);
  });

  it("never hides a live permission or question card", () => {
    const ask = msg({
      id: "ask",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    expect(shouldHideOnboardingCard(ask, [greeting, quiz, user, ask])).toBe(false);
    const question = msg({
      id: "q",
      kind: "options",
      card: {
        title: "Your bot has a question",
        subtitle: "which file?",
        options: [],
        requestId: "req-2",
      },
    });
    expect(shouldHideOnboardingCard(question, [user, question])).toBe(false);
  });
});
