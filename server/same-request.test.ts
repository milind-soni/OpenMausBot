import { describe, expect, it } from "vitest";

import { sameRequest } from "./same-request.ts";

describe("whether two requests to one bot ask the same thing", () => {
  it("reads a question passed on twice, in other case, punctuation or spacing, as one", () => {
    expect(sameRequest(
      "How many days would the database migration to the new hosting provider take, roughly?",
      "how many DAYS would the database migration to the new hosting provider take   roughly",
    )).toBe(true);
    expect(sameRequest(
      "Standing rule from the person, decided today: put reminders in the task app, never in the calendar.",
      "Standing rule from the person (decided today): put reminders in the task app - never in the calendar!",
    )).toBe(true);
  });

  const ASK = "How many days would the database migration to the new hosting provider take, roughly?";
  it.each([
    ["one word for another", ASK, "How many days would the database migration to the new hosting provider cost, roughly?"],
    ["another subject", "Please draft the reply to the customer about the late invoice and send it to me first.",
      "Please draft the reply to the customer about the refund and send it to me first."],
    ["a word more", ASK, "How many days would the database migration to the new hosting provider not take, roughly?"],
    ["a number", ASK, "How many days would the database migration to the 2 new hosting providers take, roughly?"],
    ["digits run together", `${ASK} 5-6`, `${ASK} 56`],
  ])("keeps two requests apart that differ by %s, however alike they read", (_name, asked, other) => {
    expect(sameRequest(asked, other)).toBe(false);
  });

  it("never joins short requests, which mean different things in different conversations", () => {
    expect(sameRequest("Any update on this one?", "Any update on this one?")).toBe(false);
    expect(sameRequest("", "")).toBe(false);
  });
});
