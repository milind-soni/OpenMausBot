import { describe, expect, it } from "vitest";

import { closedFence, mayHoldMath, openFence, splitMarkdownBlocks, splitStreamPieces } from "./markdown-stream-blocks";

describe("splitting streamed Markdown into blocks", () => {
  it("cuts at blank lines that close every block, and the pieces join back to the text", () => {
    const text = "# Plan\n\nFirst paragraph\nstill first.\n\n- one\n- two\n\nLast";
    const blocks = splitMarkdownBlocks(text)!;
    expect(blocks).toEqual(["# Plan\n\n", "First paragraph\nstill first.\n\n", "- one\n- two\n\n", "Last"]);
    expect(blocks.join("")).toBe(text);
  });

  it("starts a block at a list marker only when nothing above it can still hold a list", () => {
    expect(splitMarkdownBlocks("Text\n\n1. one\n\n2. two")).toEqual(["Text\n\n", "1. one\n\n2. two"]);
    expect(splitMarkdownBlocks("Text\n- one\n\n- two")).toEqual(["Text\n- one\n\n- two"]);
    expect(splitMarkdownBlocks("Text\n\n  indented\n\n- two")).toEqual(["Text\n\n  indented\n\n- two"]);
  });

  it("treats only spaces and tabs as a blank line", () => {
    expect(splitMarkdownBlocks("one\n\u00a0\ntwo\n \t\nthree")).toEqual(["one\n\u00a0\ntwo\n \t\n", "three"]);
  });

  it("does not cut after indented code before a line it would be read as interrupting", () => {
    expect(splitMarkdownBlocks("    code\n\n> -\n\nText")).toEqual(["    code\n\n> -\n\n", "Text"]);
    expect(splitMarkdownBlocks("    code\n\nText")).toEqual(["    code\n\n", "Text"]);
  });

  it("cuts around HTML that ends at a blank line, and keeps HTML that runs past them whole", () => {
    expect(splitMarkdownBlocks("<details>\n\nhidden\n\n</details>\n\nAfter")).toEqual(["<details>\n\n", "hidden\n\n", "</details>\n\n", "After"]);
    expect(splitMarkdownBlocks("<pre>\na\n\nb\n</pre>\n\nAfter")).toEqual(["<pre>\na\n\nb\n</pre>\n\n", "After"]);
    expect(splitMarkdownBlocks("Text\n<!-- a\n\nb -->\n\nAfter")).toEqual(["Text\n<!-- a\n\nb -->\n\n", "After"]);
    expect(splitMarkdownBlocks("<!DOCTYPE html>\n\n<?x ?>\n\nAfter")).toEqual(["<!DOCTYPE html>\n\n", "<?x ?>\n\n", "After"]);
    expect(splitMarkdownBlocks("One\n\n<script>\n\nnever closed\n\nmore")).toEqual(["One\n\n", "<script>\n\nnever closed\n\nmore"]);
    // Inside an HTML block a fence line is text, so the fence it seems to open cannot be trusted.
    expect(splitMarkdownBlocks("One\n\n<br>\n~~~\n\ncode\n~~~\n\nmore")).toEqual(["One\n\n", "<br>\n~~~\n\ncode\n~~~\n\nmore"]);
  });

  it("cuts around display math that stands alone, and stops cutting at any other display delimiter", () => {
    expect(splitMarkdownBlocks("One\n\n$$\nx\n\ny\n$$\n\nTwo\n\n\\[\nz\n\\]\n\nThree")).toEqual(["One\n\n", "$$\nx\n\ny\n$$\n\n", "Two\n\n", "\\[\nz\n\\]\n\n", "Three"]);
    expect(splitMarkdownBlocks("$$x^2$$\n\nOne\n\n\\[ y \\]\n\nTwo")).toEqual(["$$x^2$$\n\n", "One\n\n", "\\[ y \\]\n\n", "Two"]);
    expect(splitMarkdownBlocks("With \\(a\\) inline\n\nand $b$\n\nEnd")).toEqual(["With \\(a\\) inline\n\n", "and $b$\n\n", "End"]);
    for (const [text, kept] of [
      ["One\n\n$$\nx\n\nnever closed\n\nmore", "$$\nx\n\nnever closed\n\nmore"],
      ["One\n\nValue $$x\n\ny$$ here\n\nmore", "Value $$x\n\ny$$ here\n\nmore"],
      ["One\n\nOpen \\( a\n\nb \\) closed\n\nmore", "Open \\( a\n\nb \\) closed\n\nmore"],
      ["One\n\n$$ meta\nx\n\nmore", "$$ meta\nx\n\nmore"],
      ["One\n\n- item\n  $$\n  x\n  $$\n\nmore", "- item\n  $$\n  x\n  $$\n\nmore"],
      ["One\n\n$$\nx `y`\n$$\n\nmore", "$$\nx `y`\n$$\n\nmore"],
      ["One\n\nRun `echo $$` now\n\nmore", "Run `echo $$` now\n\nmore"],
    ] as const) expect(splitMarkdownBlocks(text), text).toEqual(["One\n\n", kept]);
    expect(splitMarkdownBlocks("```sh\necho $$\n```\n\nOne\n\nTwo"), "a fence hides its delimiters").toEqual(["```sh\necho $$\n```\n\n", "One\n\n", "Two"]);
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
      "Line\r\n\r\nother",
    ]) expect(splitMarkdownBlocks(text), text).toBeNull();
  });
});

describe("cutting a streamed list or table into pieces", () => {
  const list = (items: string[], loose = false, lead = "") => ({ kind: "list", lead, items, loose });

  it("cuts a tight list at its top-level items", () => {
    expect(splitStreamPieces("- one\n- two\n  - nested\n  more\n- thr")).toEqual(list(["- one\n", "- two\n  - nested\n  more\n", "- thr"]));
    expect(splitStreamPieces("7. one\n8. two\n\n")).toEqual(list(["7. one\n", "8. two\n\n"]));
    expect(splitStreamPieces("- one\n  ```\n  a\n\n  b\n  ```\n- two")).toEqual(list(["- one\n  ```\n  a\n\n  b\n  ```\n", "- two"]));
  });

  it("marks a list loose once a blank line separates two items", () => {
    expect(splitStreamPieces("1. one\n\n   body\n\n2. two")).toEqual(list(["1. one\n\n   body\n\n", "2. two"], true));
    expect(splitStreamPieces("- one\n- two\n\n- three")).toEqual(list(["- one\n", "- two\n\n", "- three"], true));
  });

  it("leaves a list whole when a blank line may make it loose without separating items", () => {
    expect(splitStreamPieces("- one\n\n  body\n- two")).toBeNull();
    expect(splitStreamPieces("- one\n  - a\n\n  - b\n- two")).toBeNull();
  });

  it("keeps a paragraph line above the list as its lead", () => {
    expect(splitStreamPieces("Steps:\n- one\n- two")).toEqual(list(["- one\n", "- two"], false, "Steps:\n"));
    expect(splitStreamPieces("Steps:\n1. one\n2. two")).toEqual(list(["1. one\n", "2. two"], false, "Steps:\n"));
    for (const text of ["Year\n2. two\n3. three", "Text\n-\n- two", "Text\n- - x\n- two", "<div>\n- one\n- two", "a | b\n- | -\n- x"]) expect(splitStreamPieces(text), text).toBeNull();
  });

  it("lets digits that may become the next marker stay with the last item", () => {
    expect(splitStreamPieces("1. one\n2. two\n12")).toEqual(list(["1. one\n", "2. two\n12"]));
    expect(splitStreamPieces("- one\n- two\n12")).toBeNull();
  });

  it("leaves a list whole when a line is not plainly an item or inside one", () => {
    for (const text of [
      "- one\n* two", "1. one\n2) two", "- one\n- - -\n- two", "- one\n---\n- two", "- one\nlazy\n- two", "1. one\n  - under-indented\n2. two",
      "- one\n  ```\n  code\n- two", "-\n\n  not inside\n- two", "- one\n  <div>\n- two", "- one\n\t- tab\n- two", "- costs $5\n- two", "- \\(x\\)\n- two",
    ]) expect(splitStreamPieces(text), text).toBeNull();
  });

  it("cuts a table into its header and rows", () => {
    expect(splitStreamPieces("| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |")).toEqual({ kind: "table", head: "| a | b |\n|---|:-:|\n", rows: ["| 1 | 2 |\n", "| 3 |"] });
    expect(splitStreamPieces("| a | b |\n|---|---|\n| 1 | 2 |\n\n")).toEqual({ kind: "table", head: "| a | b |\n|---|---|\n", rows: ["| 1 | 2 |\n\n"] });
    expect(splitStreamPieces("| a | b |\n|---|---|")).toEqual({ kind: "table", head: "| a | b |\n|---|---|", rows: [] });
  });

  it("leaves a table whole until its header is certain and while a row may not be one", () => {
    for (const text of [
      "| a | b |", "| a | b |\n|---|", "| a | b |\n|---|---|---|", "| a |\n|---|\n| 1 |", "| `a` | b |\n|---|---|\n| 1 | 2 |", "a | b\n--|--\n1 | 2",
      "| a | b |\n|---|---|\n| 1 | 2 |\n3 | 4", "| a | b |\n|---|---|\n| 1 | 2 |\n> quote", "| a | b |\n|---|---|\n| $1 | 2 |",
    ]) expect(splitStreamPieces(text), text).toBeNull();
  });

  it("knows which text math normalization leaves alone", () => {
    expect(["plain `code` | text", "a (b) [c]"].map(mayHoldMath)).toEqual([false, false]);
    expect(["$5", "\\(x\\)", "\\[x\\]", "a\u0000b"].map(mayHoldMath)).toEqual([true, true, true, true]);
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
