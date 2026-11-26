import { describe, expect, it } from "vitest";
import type { WireMessage as Message } from "../../shared/wire.ts";
import { earlierAnswers } from "./check-rounds";

const row = (id: string, fields: Partial<Message>): Message => ({ id, at: 1, role: "bot", kind: "text", ...fields }) as Message;
const ask = (id: string) => row(id, { role: "user", text: "Write the chapter" });
const answer = (id: string, text = `answer ${id}`) => row(id, { text });
const found = (id: string, round: number) => row(id, { kind: "activity", tool: { name: "Vera found 2 issues", ok: true }, checkRound: round });
const passed = (id: string) => row(id, { kind: "activity", tool: { name: "Checked by Vera · passed", ok: true }, threadRef: { botId: "vera", threadId: "check", title: "Check" } });

describe("earlierAnswers", () => {
  it("folds each answer a check sent back, with its round, and keeps the last answer whole", () => {
    const messages = [ask("q"), answer("a1"), found("f1", 1), answer("a2"), found("f2", 2), answer("a3"), passed("p")];
    expect([...earlierAnswers(messages)]).toEqual([["a1", 1], ["a2", 2]]);
  });

  it("folds every line of an answer given in several messages, and none of the fixed one", () => {
    const messages = [ask("q"), answer("a1"), row("tool", { kind: "activity", tool: { name: "search", ok: true } }), answer("a1b"), found("f1", 1), answer("a2"), answer("a2b")];
    expect([...earlierAnswers(messages)]).toEqual([["a1", 1], ["a1b", 1]]);
  });

  it("folds nothing in a chat with no check line, and never an answer to an earlier request", () => {
    expect(earlierAnswers([ask("q"), answer("a1"), passed("p"), ask("q2"), answer("a2")]).size).toBe(0);
    expect([...earlierAnswers([ask("q"), answer("old"), ask("q2"), answer("a1"), found("f1", 1), answer("a2")])]).toEqual([["a1", 1]]);
  });

  it("keeps the answer whole when the fix wrote nothing, as that answer is the one delivered", () => {
    expect(earlierAnswers([ask("q"), answer("a1"), found("f1", 1), row("n", { kind: "activity", tool: { name: "notice: Not checked: the fix did not finish", ok: false } })]).size).toBe(0);
    expect([...earlierAnswers([ask("q"), answer("a1"), found("f1", 1), answer("a2"), found("f2", 2)])]).toEqual([["a1", 1]]);
    expect(earlierAnswers([ask("q"), answer("a1"), found("f1", 1), ask("q2"), answer("b1")]).size).toBe(0);
  });

  it("skips empty lines and lines from another bot", () => {
    const messages = [ask("q"), answer("blank", "  "), row("peer", { text: "from a teammate", from: { botId: "x", name: "X", color: "blue" } }), answer("a1"), found("f1", 1), answer("a2")];
    expect([...earlierAnswers(messages)]).toEqual([["a1", 1]]);
  });
});
