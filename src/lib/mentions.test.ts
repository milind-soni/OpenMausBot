import { describe, expect, it } from "vitest";
import { mentionChoicesForQuery, mentionClassName, mentionRanges, mentionRowDescription } from "./mentions";

const peers = [{ name: "Atlas" }, { name: "New Bot" }, { name: "New Bot 2" }, { name: "調査担当" }, { name: "Hidden", hidden: true }];
const matches = (text: string, everyone = false) => mentionRanges(text, peers, everyone).map(({ start, end }) => text.slice(start, end));

describe("mention display ranges", () => {
  it("keeps original casing, duplicate occurrences and longest names", () => {
    expect(matches("@ATLAS, ask @New Bot 2 and @Atlas.")).toEqual(["@ATLAS", "@New Bot 2", "@Atlas"]);
  });
  it("supports multiline Unicode text without changing original offsets", () => {
    expect(matches("İ 😀 message\n@調査担当 確認して\n@Atlas")).toEqual(["@調査担当", "@Atlas"]);
  });
  it("ignores emails, unknown/hidden bots, partial names and longer words", () => {
    expect(matches("mail me@Atlas.test @Ghost @Hidden @Atl @Atlas2 @New Bottle https://host/@Atlas")).toEqual([]);
  });
  it("accepts Markdown and opening punctuation boundaries", () => {
    expect(matches("**@Atlas** (@New Bot 2) 【@調査担当】")).toEqual(["@Atlas", "@New Bot 2", "@調査担当"]);
    expect(matches("user@Atlas /@Atlas")).toEqual([]);
  });
  it("only decorates everyone in channels and rejects longer words", () => {
    expect(matches("@everyone @Everyone! @everyone_else @everyone2", true)).toEqual(["@everyone", "@Everyone"]);
    expect(matches("@everyone")).toEqual([]);
  });
  it("rejects Unicode letters, numbers, combining marks and underscores after names", () => {
    expect(matches("@調査担当者 @everyone調査 @Atlasé @Atlas２ @Atlas𐐀 @Atlas𝟙 @Atlas\u0301 @Atlas_else", true)).toEqual([]);
    expect(matches("@everyoneé @everyone２ @everyone𐐀 @everyone𝟙 @everyone\u0301", true)).toEqual([]);
    expect(matches("@調査担当、 @Atlas! @everyone。 @Atlas😀", true)).toEqual(["@調査担当", "@Atlas", "@everyone", "@Atlas"]);
    const text = "@調査担当者 @everyone調査";
    expect(mentionRanges(text, [{ name: "調査担当" }, { name: "調査担当者" }, { name: "everyone調査" }], true))
      .toEqual([{ start: 0, end: 6 }, { start: 7, end: 18 }]);
  });
  it("does not interpret names as regular expressions or HTML", () => {
    const text = "@A+B and @<img>";
    expect(mentionRanges(text, [{ name: "A+B" }, { name: "<img>" }])).toEqual([{ start: 0, end: 4 }, { start: 9, end: 15 }]);
  });
});

describe("the @devs tag in display ranges", () => {
  it("is drawn like a tag, in any chat, unless a bot has that name", () => {
    expect(matches("@devs the page froze, @Devs! but not ops@devs.test or @devsite")).toEqual(["@devs", "@Devs"]);
    expect(mentionRanges("@devs hi", [{ name: "Devs", color: "blue" }]).map((range) => range.color)).toEqual(["#377FE6"]);
  });
});

describe("the person's tag in display ranges", () => {
  const person = { profileName: "Sam" };
  const ranges = (text: string, roster = peers, everyone = false) => mentionRanges(text, roster, everyone, person)
    .map(({ start, end, you }) => [text.slice(start, end), you ?? false]);

  it("marks @you and the profile name as the person's, beside bot tags", () => {
    expect(ranges("@Atlas asks @you and @SAM; mail sam@you.com")).toEqual([
      ["@Atlas", false], ["@you", true], ["@SAM", true],
    ]);
  });
  it("is off unless a caller asks for it, as in the composer", () => {
    expect(matches("@you @Sam")).toEqual([]);
  });
  it("lets a bot with the same name keep its mentions", () => {
    expect(ranges("@you @Sam", [{ name: "You" }, { name: "Sam" }])).toEqual([["@you", false], ["@Sam", false]]);
    expect(ranges("@you", [{ name: "You", hidden: true }])).toEqual([["@you", true]]);
  });
  it("leaves @everyone as it was", () => {
    expect(ranges("@everyone then @you", peers, true)).toEqual([["@everyone", false], ["@you", true]]);
  });
});

describe("a teammate's tag in display ranges", () => {
  const roster = [...peers, { name: "Bob Stone", person: true as const }, { name: "Bob", person: true as const }];
  it("marks a teammate as a person, never in a bot's colour, and the viewer's own name stays theirs", () => {
    const text = "@Atlas and @Bob Stone, then @Bob, then @Sam";
    expect(mentionRanges(text, roster, false, { profileName: "Sam" }).map(({ start, end, person, you }) => [text.slice(start, end), person ?? false, you ?? false]))
      .toEqual([["@Atlas", false, false], ["@Bob Stone", true, false], ["@Bob", true, false], ["@Sam", false, true]]);
    expect(mentionClassName({ person: true })).toBe("mention-highlight mention-person");
  });
  it("does not let a teammate's name take the viewer's own tag away", () => {
    expect(mentionRanges("@Sam", [{ name: "Sam", person: true }], false, { profileName: "Sam" })).toEqual([{ start: 0, end: 4, you: true }]);
  });
});

describe("mention picker choices", () => {
  const choices = ["everyone", "One", "Two", "Three", "Four", "Five", "Six"]
    .map((name, index) => ({ id: String(index), name }));

  it("keeps every room member instead of truncating after everyone plus five bots", () => {
    expect(mentionChoicesForQuery(choices, "")).toEqual(choices);
  });

  it("filters before display and closes after a completed exact tag", () => {
    expect(mentionChoicesForQuery(choices, "si").map((choice) => choice.name)).toEqual(["Six"]);
    expect(mentionChoicesForQuery(choices, "Six ")).toEqual([]);
  });

  it("filters by name only, so a title never opens a row the insert would not match", () => {
    const titled = [{ name: "Atlas", title: "Research lead" }];
    expect(mentionChoicesForQuery(titled, "research")).toEqual([]);
    expect(mentionChoicesForQuery(titled, "atl")).toEqual(titled);
  });
});

describe("mention row description", () => {
  it("uses a bot title and omits a blank one", () => {
    expect(mentionRowDescription({ kind: "bot", title: "  Research lead  " })).toBe("Research lead");
    expect(mentionRowDescription({ kind: "bot", title: "  " })).toBe("");
  });

  it("counts the bots @everyone reaches", () => {
    expect(mentionRowDescription({ kind: "everyone", count: 1 })).toBe("1 bot in this chat");
    expect(mentionRowDescription({ kind: "everyone", count: 6 })).toBe("6 bots in this chat");
  });
});
