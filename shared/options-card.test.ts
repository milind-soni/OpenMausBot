import { describe, expect, it } from "vitest";

import { OPTIONS_CARD_LIMITS, parseOptionsCardInput } from "./options-card.ts";

describe("parseOptionsCardInput", () => {
  it("trims a valid card and preserves option order", () => {
    expect(parseOptionsCardInput({
      title: "  Watcher found a match  ",
      subtitle: "  What should happen next?  ",
      options: ["  Ignore  ", "Draft a comment"],
    })).toEqual({
      ok: true,
      value: {
        title: "Watcher found a match",
        subtitle: "What should happen next?",
        options: ["Ignore", "Draft a comment"],
      },
    });
  });

  it("requires an object and all three fields", () => {
    expect(parseOptionsCardInput(null)).toEqual({ ok: false, error: "create_options_card needs an object." });
    expect(parseOptionsCardInput({ title: "Title", options: ["A", "B"] })).toEqual({
      ok: false,
      error: "subtitle must be a string.",
    });
  });

  it("requires two through six options", () => {
    const card = { title: "Title", subtitle: "Subtitle" };
    expect(parseOptionsCardInput({ ...card, options: ["Only"] })).toEqual({
      ok: false,
      error: "options must contain 2-6 items.",
    });
    expect(parseOptionsCardInput({ ...card, options: ["1", "2", "3", "4", "5", "6", "7"] })).toEqual({
      ok: false,
      error: "options must contain 2-6 items.",
    });
  });

  it("rejects blank, non-string and duplicate normalized choices", () => {
    const card = { title: "Title", subtitle: "Subtitle" };
    expect(parseOptionsCardInput({ ...card, options: ["A", " "] })).toMatchObject({ ok: false, error: "options[1] must not be blank." });
    expect(parseOptionsCardInput({ ...card, options: ["A", 2] })).toMatchObject({ ok: false, error: "options[1] must be a string." });
    expect(parseOptionsCardInput({ ...card, options: ["A", " A "] })).toEqual({
      ok: false,
      error: 'options must be unique; "A" is repeated.',
    });
  });

  it("enforces the display-size limits", () => {
    expect(parseOptionsCardInput({
      title: "x".repeat(OPTIONS_CARD_LIMITS.title + 1),
      subtitle: "Subtitle",
      options: ["A", "B"],
    })).toMatchObject({ ok: false, error: `title must be at most ${OPTIONS_CARD_LIMITS.title} characters.` });
    expect(parseOptionsCardInput({
      title: "Title",
      subtitle: "Subtitle",
      options: ["A", "x".repeat(OPTIONS_CARD_LIMITS.option + 1)],
    })).toMatchObject({ ok: false, error: `options[1] must be at most ${OPTIONS_CARD_LIMITS.option} characters.` });
  });
});
