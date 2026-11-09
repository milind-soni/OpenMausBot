import { describe, expect, it } from "vitest";
import { checkDreamFacts } from "./memory-fact-checks.ts";
import type { DreamConversation } from "./memory-dream.ts";

const person = (text: string): DreamConversation => ({ threadId: text, lines: [{ by: "person", text }] });
const chats = [
  person("Anna's budget is 250. Notes live in /work/anna.md and https://example.test/anna."),
  person("Anna likes short replies too."),
];
const quotes = [chats[0]!.lines[0]!.text, chats[1]!.lines[0]!.text];
const check = (text: string, evidence: readonly string[] | undefined = quotes) => checkDreamFacts(text, [1, 2], evidence, chats);

describe("the checks before a dream saves a fact", () => {
  it("keeps an entry whose numbers, paths and URLs all come from the quotes", () => {
    expect(check("The person's budget is 250")).toBe(true);
    expect(check("The person keeps notes in /work/anna.md and https://example.test/anna")).toBe(true);
  });

  it.each(["The budget is 251", "The person uses /work/bob.md", "The person uses https://example.test/bob"])("refuses an entry with a detail no quote holds: %s", (text) => {
    expect(check(text)).toBe(false);
  });

  it("saves facts in any language, with no list of months, relations or names to pass", () => {
    const german = person("Die Person trinkt gern Kaffee am Morgen.");
    const cyrillic = person("Человек предпочитает короткие ответы.");
    expect(checkDreamFacts("Die Person mag Kaffee am Morgen", [1], [german.lines[0]!.text], [german])).toBe(true);
    expect(checkDreamFacts("Человек любит короткие ответы", [1], [cyrillic.lines[0]!.text], [cyrillic])).toBe(true);
  });

  it("needs one real statement by the person in each cited conversation", () => {
    expect(check("Anna likes short replies", ["Invented quotation", quotes[1]!])).toBe(false);
    expect(check("Anna likes short replies", [])).toBe(false);
    expect(check("Anna likes short replies", undefined)).toBe(false);
    expect(checkDreamFacts("Anna likes tea", [1], ["Anna likes tea"], [{ threadId: "q", lines: [{ by: "bot", text: "Anna likes tea" }] }])).toBe(false);
    expect(checkDreamFacts("Anna likes tea", [1], ["Anna likes tea"], [person("Suppose Anna likes tea?")])).toBe(false);
  });

  it("refuses secrets even when the person really said them", () => {
    const secret = "password: synthetic-secret-123";
    expect(checkDreamFacts(secret, [1], [secret], [person(secret)])).toBe(false);
  });
});
