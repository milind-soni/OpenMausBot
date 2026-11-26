import { describe, expect, it } from "vitest";

import { cleanSuggestion, lastExchange, type SuggestionRow } from "./suggested-reply.ts";

const ask = (id: string, text: string, extra: Partial<SuggestionRow> & Record<string, unknown> = {}): SuggestionRow => ({ id, role: "user", kind: "text", text, ...extra });
const reply = (id: string, text: string, extra: Record<string, unknown> = {}): SuggestionRow => ({ id, role: "bot", kind: "text", text, ...extra });
const step = (id: string): SuggestionRow => ({ id, role: "bot", kind: "activity" });
const LONG = "I drafted the email to the team and saved it in your drafts folder.";

describe("lastExchange", () => {
  it("is the person's last message and the bot's finished reply, ignoring older turns and the work in between", () => {
    const rows = [ask("u0", "older question"), reply("b0", "an older answer that is long enough"), ask("u1", "Draft the email"), step("s1"), reply("b1", LONG), step("s2")];
    expect(lastExchange(rows)).toEqual({ ask: "Draft the email", askId: "u1", reply: LONG, replyId: "b1" });
  });

  it("has nothing while the bot has not answered the newest message", () => {
    expect(lastExchange([ask("u0", "hi"), reply("b0", LONG), ask("u1", "and then?")])).toBeNull();
    expect(lastExchange([ask("u1", "and then?"), step("s1")])).toBeNull();
    expect(lastExchange([])).toBeNull();
  });

  it("has nothing when the reply ends in a card, choice or approval", () => {
    expect(lastExchange([ask("u", "go"), reply("b", LONG), { id: "o", role: "bot", kind: "options" }])).toBeNull();
    expect(lastExchange([ask("u", "go"), reply("b", LONG, { card: { requestId: "r" } })])).toBeNull();
    expect(lastExchange([ask("u", "go"), reply("b", LONG, { setupChoices: ["a", "b"] })])).toBeNull();
    expect(lastExchange([ask("u", "go"), reply("b", LONG), { id: "w", role: "bot", kind: "widget" }])).toBeNull();
  });

  it("has nothing after a trivial reply or an automated ask", () => {
    expect(lastExchange([ask("u", "send it"), reply("b", "Done.")])).toBeNull();
    expect(lastExchange([ask("u", "daily brief", { automated: { kind: "routine" } }), reply("b", LONG)])).toBeNull();
    expect(lastExchange([ask("u", "check this", { peerAsk: { botId: "b2", name: "Rex" } }), reply("b", LONG)])).toBeNull();
    expect(lastExchange([ask("u", "go"), reply("b", LONG, { stoppedBy: "person" })])).toBeNull();
  });

  it("keeps the end of a very long reply", () => {
    const long = `${"start ".repeat(1_000)}the end`;
    const found = lastExchange([ask("u", "write a lot"), reply("b", long)]);
    expect(found?.reply.endsWith("the end")).toBe(true);
    expect(found!.reply.length).toBeLessThanOrEqual(3_001);
  });
});

describe("cleanSuggestion", () => {
  it("keeps one short plain line", () => {
    expect(cleanSuggestion("Send it to Priya too")).toBe("Send it to Priya too");
    expect(cleanSuggestion("\"Send it to Priya too\"\n\nThis is a good next step.")).toBe("Send it to Priya too");
    expect(cleanSuggestion("Suggestion: Make it shorter")).toBe("Make it shorter");
    expect(cleanSuggestion("- Make it shorter")).toBe("Make it shorter");
  });

  it("drops NONE, empty and long answers", () => {
    expect(cleanSuggestion("NONE")).toBeNull();
    expect(cleanSuggestion("  \n ")).toBeNull();
    expect(cleanSuggestion(null)).toBeNull();
    expect(cleanSuggestion("word ".repeat(20))).toBeNull();
  });
});
