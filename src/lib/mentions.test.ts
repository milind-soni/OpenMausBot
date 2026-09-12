import { describe, expect, it } from "vitest";
import { mentionChoicesForQuery, mentionRanges } from "./mentions";

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
});
