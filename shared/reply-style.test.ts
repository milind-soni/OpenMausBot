import { describe, expect, it } from "vitest";

import { isConversational, splitConversationalReply } from "./reply-style.ts";

describe("splitConversationalReply", () => {
  it("splits short paragraphs into separate messages", () => {
    expect(splitConversationalReply("Found it.\n\nThe file is in src.\n\n\nWant me to open it?")).toEqual([
      "Found it.",
      "The file is in src.",
      "Want me to open it?",
    ]);
  });

  it("keeps a single paragraph as one message", () => {
    expect(splitConversationalReply("Just one line\nand its second line")).toEqual(["Just one line\nand its second line"]);
  });

  it("never cuts a code fence that holds blank lines", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitConversationalReply(`Here you go.\n\n${code}\n\nThat is it.`)).toEqual(["Here you go.", code, "That is it."]);
  });

  it("keeps a still streaming fence in the last part", () => {
    expect(splitConversationalReply("Done.\n\n```py\nx = 1\n\ny = 2")).toEqual(["Done.", "```py\nx = 1\n\ny = 2"]);
  });

  it("keeps the blocks of one loose list together", () => {
    expect(splitConversationalReply("Two options.\n\n- first\n\n- second\n\nPick one?")).toEqual([
      "Two options.",
      "- first\n\n- second",
      "Pick one?",
    ]);
  });

  it("keeps the indentation of an indented code block", () => {
    expect(splitConversationalReply("Run this:\n\n    npm test\n\nDone?")).toEqual(["Run this:", "    npm test", "Done?"]);
  });

  it("returns nothing for blank text", () => {
    expect(splitConversationalReply("  \n\n ")).toEqual([]);
  });
});

describe("isConversational", () => {
  it("is false for an absent or default style", () => {
    expect(isConversational(undefined)).toBe(false);
    expect(isConversational("default")).toBe(false);
    expect(isConversational("conversational")).toBe(true);
  });
});
