import { describe, expect, it } from "vitest";
import { checkDreamFacts } from "./memory-fact-checks.ts";
import type { DreamConversation } from "./memory-dream.ts";

const chats: DreamConversation[] = [
  { threadId: "a", lines: [{ by: "person", text: "Anna, my sister, moved yesterday to York. Her budget is 250 in March. Notes: /work/anna.md https://example.test/anna", at: Date.parse("2026-10-20T12:00:00Z") }] },
  { threadId: "b", lines: [{ by: "person", text: "Anna likes short replies too.", at: Date.parse("2026-10-21T12:00:00Z") }] },
];
const quotes = [chats[0]!.lines[0]!.text, chats[1]!.lines[0]!.text];
const check = (text: string, evidence = quotes) => checkDreamFacts(text, [1, 2], evidence, chats);

describe("dream fact checks", () => {
  it("keeps supported facts and anchors relative dates to the quoted message", () => {
    expect(check("Anna, my sister, moved yesterday to York")).toBe("Anna, my sister, moved 2026-10-19 to York");
    expect(check("Anna, my sister, has a budget of 250 in March")).toBe("Anna, my sister, has a budget of 250 in March");
    expect(check("Anna, my sister, uses /work/anna.md and https://example.test/anna")).toBeTruthy();
  });
  it.each(["Anna has 251", "Anna visits in April", "Anna moved on 2026-10-18", "Anna uses /work/bob.md", "Anna uses https://example.test/bob", "Alice likes short replies", "Anna, my mother, moved to York"])("rejects an unsupported fact: %s", (text) => {
    expect(check(text)).toBeNull();
  });
  it("requires actual owner statements in every cited chat", () => {
    expect(check("Anna likes short replies", ["Invented quotation", quotes[1]!])).toBeNull();
    expect(check("Anna likes short replies", [])).toBeNull();
    expect(checkDreamFacts("Anna likes tea", [1], ["Anna likes tea"], [{ threadId: "q", lines: [{ by: "bot", text: "Anna likes tea" }] }])).toBeNull();
    expect(checkDreamFacts("Anna likes tea", [1], ["Anna likes tea"], [{ threadId: "q", lines: [{ by: "person", text: "Suppose Anna likes tea?" }] }])).toBeNull();
  });
  it("rejects secrets even when the source contains them", () => {
    const secret = "password: synthetic-secret-123";
    expect(checkDreamFacts(secret, [1], [secret], [{ threadId: "s", lines: [{ by: "person", text: secret }] }])).toBeNull();
  });
  it.each(["dziś", "dzisiaj", "wczoraj", "jutro", "today", "yesterday", "tomorrow"])("resolves %s at a month boundary", (word) => {
    const text = `Anna ${word}`;
    const day = ["wczoraj", "yesterday"].includes(word) ? "2026-02-28" : ["jutro", "tomorrow"].includes(word) ? "2026-03-02" : "2026-03-01";
    expect(checkDreamFacts(text, [1], [text], [{ threadId: "d", lines: [{ by: "person", text, at: Date.parse("2026-03-01T12:00:00Z") }] }])).toBe(`Anna ${day}`);
  });
  it("refuses relative dates without an anchor or with ambiguous source days", () => {
    expect(checkDreamFacts("Anna today", [1], ["Anna today"], [{ threadId: "x", lines: [{ by: "person", text: "Anna today" }] }])).toBeNull();
    expect(checkDreamFacts("Anna today", [1, 2], ["Anna today", "Anna today"], [0, 1].map((i) => ({ threadId: String(i), lines: [{ by: "person" as const, text: "Anna today", at: Date.parse(`2026-10-2${i}T12:00:00Z`) }] })))).toBeNull();
  });
  it("leaves relative-date words inside paths and URLs alone", () => {
    const text = "Anna keeps notes in /notes/today.md and https://example.test/today";
    expect(checkDreamFacts(text, [1], [text], [{ threadId: "p", lines: [{ by: "person", text }] }])).toBe(text);
    const dated = "Anna wrote /notes/today.md today";
    expect(checkDreamFacts(dated, [1], [dated], [{ threadId: "p", lines: [{ by: "person", text: dated, at: Date.parse("2026-03-01T12:00:00Z") }] }])).toBe("Anna wrote /notes/today.md 2026-03-01");
  });
});
