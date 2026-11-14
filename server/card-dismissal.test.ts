// Closing a question card with its X, as both respond endpoints answer it.
import { describe, expect, it, vi } from "vitest";

import { QUESTION_DISMISS_MESSAGE } from "../shared/ask-question.ts";
import { dismissQuestionCard } from "./card-dismissal.ts";
import type { Message } from "./store.ts";

const question = (card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: "m1", at: 1, role: "bot", kind: "options",
  card: { title: "Which file?", subtitle: "", options: ["a.ts", "b.ts"], requestId: "r1", requestType: "question", ...card },
});

describe("dismissQuestionCard", () => {
  it("closes an answered question, by the dismiss flag or by the dismiss message", () => {
    for (const body of [{ dismiss: true }, { message: QUESTION_DISMISS_MESSAGE }]) {
      const patchMessage = vi.fn();
      const pending = question({ answered: "answer", answeredText: "a.ts" });
      expect(dismissQuestionCard({ patchMessage }, "t1", pending, body)).toEqual({ status: 200, body: { ok: true, dismissed: true } });
      expect(patchMessage).toHaveBeenCalledWith("t1", "m1", { card: { ...pending.card, dismissed: true } });
    }
  });

  it("refuses to close a question nobody answered, or one already closed", () => {
    const patchMessage = vi.fn();
    const refused = { status: 409, body: { error: "answer this question before dismissing it" } };
    expect(dismissQuestionCard({ patchMessage }, "t1", question(), { dismiss: true })).toEqual(refused);
    expect(dismissQuestionCard({ patchMessage }, "t1", question({ answered: "unavailable" }), { dismiss: true })).toEqual(refused);
    expect(dismissQuestionCard({ patchMessage }, "t1", question({ answered: "answer", dismissed: true }), { dismiss: true })).toEqual(refused);
    expect(patchMessage).not.toHaveBeenCalled();
  });

  it("leaves an answer, a permission card and a missing card to the rest of the endpoint", () => {
    const patchMessage = vi.fn();
    expect(dismissQuestionCard({ patchMessage }, "t1", question({ answered: "answer" }), { message: "a.ts" })).toBeNull();
    expect(dismissQuestionCard({ patchMessage }, "t1", question({ requestType: "permission", tool: "Bash" }), { dismiss: true })).toBeNull();
    expect(dismissQuestionCard({ patchMessage }, "t1", undefined, { dismiss: true })).toBeNull();
    expect(patchMessage).not.toHaveBeenCalled();
  });
});
