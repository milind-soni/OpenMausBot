import { describe, expect, it } from "vitest";

import { closedFence, openFence, splitMarkdownBlocks } from "./markdown-stream-blocks";

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
      "A claim.[^1]\n\n[^1]: The source.",
      "<details>\n\nhidden\n\n</details>",
      "$$\nx^2\n\n$$",
      "\\[\na\n\\]",
      "::: note\n\nbody\n:::",
      "Line\r\n\r\nother",
    ]) expect(splitMarkdownBlocks(text), text).toBeNull();
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
