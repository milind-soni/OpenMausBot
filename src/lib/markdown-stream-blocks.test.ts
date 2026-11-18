import { describe, expect, it } from "vitest";

import { closedFence, openFence, splitMarkdownBlocks, splitStreamingBlock } from "./markdown-stream-blocks";

describe("splitting streamed Markdown into blocks", () => {
  it("cuts at blank lines that close every block, and the pieces join back to the text", () => {
    // A list marker after a blank line may still belong to what is above it, so it never starts a block.
    const text = "# Plan\n\nFirst paragraph\nstill first.\n\n- one\n- two\n\nLast";
    const blocks = splitMarkdownBlocks(text)!;
    expect(blocks).toEqual(["# Plan\n\n", "First paragraph\nstill first.\n\n- one\n- two\n\n", "Last"]);
    expect(blocks.join("")).toBe(text);
  });

  it("keeps a loose list and indented content in one block", () => {
    const text = "- one\n\n- two\n\n  more of two\n\nAfter";
    expect(splitMarkdownBlocks(text)).toEqual(["- one\n\n- two\n\n  more of two\n\n", "After"]);
  });

  it("never cuts inside a code fence, closed or still open", () => {
    const closed = "Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro";
    expect(splitMarkdownBlocks(closed)).toEqual(["Intro\n\n", "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n", "Outro"]);
    const open = "Intro\n\n~~~\nline\n\nmore";
    expect(splitMarkdownBlocks(open)).toEqual(["Intro\n\n", "~~~\nline\n\nmore"]);
  });

  it("stops at an indented fence's edge, leaving the rest to the last block", () => {
    const text = "- item\n\n  ```\n  code\n\nloose";
    const blocks = splitMarkdownBlocks(text)!;
    expect(blocks.join("")).toBe(text);
    expect(blocks.at(-1)).toContain("code");
  });

  it("falls back to the whole text when syntax ties blocks together", () => {
    for (const text of [
      "See [the docs][1].\n\n[1]: https://example.com",
      "<!-- note\n\nstill a comment -->",
      "<pre>\n\nkept\n\n</pre>",
      "Total $$$5",
      "An odd $$ pair\n\nx $$",
      "\\[\na\n\\]",
      "::: note\n\nbody\n:::",
      "Line\r\n\r\nother",
    ]) expect(splitMarkdownBlocks(text), text).toBeNull();
  });

  it("cuts around HTML that a blank line ends", () => {
    expect(splitMarkdownBlocks("<details>\n\nhidden\n\n</details>")).toEqual(["<details>\n\n", "hidden\n\n", "</details>"]);
  });

  it("never cuts inside display math, and cuts around it and around pairs on one line", () => {
    expect(splitMarkdownBlocks("Intro\n\n$$\nx^2\n\n= y\n$$\n\nAnd $$a$$ b\n\nEnd")).toEqual(["Intro\n\n", "$$\nx^2\n\n= y\n$$\n\n", "And $$a$$ b\n\n", "End"]);
  });

  it("keeps everything from a reply's first footnote in one block", () => {
    expect(splitMarkdownBlocks("Intro\n\nA claim.[^1]\n\nMore\n\n[^1]: The source.")).toEqual(["Intro\n\n", "A claim.[^1]\n\nMore\n\n[^1]: The source."]);
  });
});

describe("cutting a growing list or table", () => {
  it("cuts a tight list between its column-0 items, after the text above it", () => {
    expect(splitStreamingBlock("Plan:\n- one\n  - nested\n- two\n- th")).toEqual({ kind: "list", head: "Plan:\n", lead: "", pieces: ["- one\n  - nested", "- two", "- th"] });
    expect(splitStreamingBlock("Steps:\n\n1. one\n2. two\n3.")).toEqual({ kind: "list", head: "Steps:\n\n", lead: "", pieces: ["1. one", "2. two\n3."] });
  });

  it("cuts a table between its rows, each parsed after the header and delimiter", () => {
    expect(splitStreamingBlock("| a | b |\n| - | :-: |\n| 1 | 2 |\n| 3\n")).toEqual({ kind: "table", head: "", lead: "| a | b |\n| - | :-: |\n", pieces: ["| 1 | 2 |", "| 3"] });
  });

  it("leaves whole any shape it cannot prove", () => {
    for (const text of [
      "- one\n\n- two",
      "- one\nlazy\n- two",
      "- one\n* two",
      "- one\n- - -",
      "- one\n# Heading",
      "Intro\n2. two\n3. three",
      "- costs $5\n- and $10",
      "- a claim[^1]\n- b",
      "- ![image](a.png)\n- b",
      "| a | b |\n| - | - |\n| 1 | 2 |\nbar",
      "| a | b |\n| - | - |",
      "Intro\n| a | b |\n| - | - |\n| 1 | 2 |",
      "- one",
      "Just prose\nover two lines",
    ]) expect(splitStreamingBlock(text), text).toBeNull();
  });
});

describe("a fence still being written", () => {
  it("is read without parsing while it has no closing line", () => {
    expect(openFence("```ts wrap\nconst a = 1;\nconst b")).toEqual({ info: "ts wrap", code: "const a = 1;\nconst b" });
    expect(openFence("```")).toEqual({ info: "", code: "" });
    expect(openFence("~~~~\nx\n~~~\n")).toEqual({ info: "", code: "x\n~~~" });
  });

  it("is not one once it closes, or when the block is not a fence", () => {
    expect(openFence("```js\ncode\n```\n")).toBeNull();
    expect(openFence("~~~\ncode\n~~~~")).toBeNull();
    expect(openFence("Prose with ``` in it")).toBeNull();
    expect(openFence("``` inline ` tick")).toBeNull();
  });

  it("tells a closed fence from an open one by its last line", () => {
    const closed = "```js\ncode\n```";
    expect(closedFence(closed, 0, closed.length)).toBe(true);
    const open = "```js\ncode\nmore";
    expect(closedFence(open, 0, open.length)).toBe(false);
    expect(closedFence("```", 0, 3)).toBe(false);
    expect(closedFence("````\na\n```", 0, 10), "a shorter closer does not close").toBe(false);
    expect(closedFence("    indented code", 0, 17), "indented code has no fence").toBe(true);
    expect(closedFence("anything", undefined, undefined)).toBe(true);
  });
});
