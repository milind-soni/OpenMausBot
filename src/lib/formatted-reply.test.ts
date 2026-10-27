import { describe, expect, it } from "vitest";
import { isFormattedReply } from "./formatted-reply";

describe("isFormattedReply", () => {
  it.each([
    ["a bullet list", "Three things:\n- Acme\n- Priya"],
    ["a numbered list", "1. Acme wants the invoice"],
    ["a heading", "## By sender\nAcme wrote twice."],
    ["a code fence", "The filter:\n```js\nmail.filter(Boolean)\n```"],
    ["a quote", "> I archived 31 newsletters."],
    ["a table", "| Sender | Emails |\n| --- | ---: |\n| Acme | 4 |"],
  ])("treats %s as formatted", (_label, text) => {
    expect(isFormattedReply(text)).toBe(true);
  });

  it.each([
    ["a chat line", "Done. I will look every morning at 8."],
    ["two paragraphs", "Done.\n\nI will write here when something needs you."],
    ["a dash inside a sentence", "Acme - the invoice - is due Friday."],
    ["a pipe inside a sentence", "Pick red | blue"],
    ["a hashtag", "#launch went well"],
    ["a number that starts a line", "2024 was a good year."],
  ])("keeps %s as a chat line", (_label, text) => {
    expect(isFormattedReply(text)).toBe(false);
  });
});
