import { describe, expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";

import {
  findLocalFileReferences,
  isPreviewableDocument,
  transformLocalFileLinks,
  type MdNode,
} from "./markdown-file-links.ts";

describe("findLocalFileReferences", () => {
  it("finds file:// URLs in text and strips trailing sentence punctuation", () => {
    const text = "Saved to file:///Users/alex/report.md. Check file:///tmp/test.json!";
    const matches = findLocalFileReferences(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]?.path).toBe("file:///Users/alex/report.md");
    expect(matches[1]?.path).toBe("file:///tmp/test.json");
  });

  it("finds angle-bracketed local paths and file URLs", () => {
    const text = "See <file:///Users/alex/report.md> and </tmp/notes.txt> and <C:\\data\\table.csv>";
    const matches = findLocalFileReferences(text);
    expect(matches).toHaveLength(3);
    expect(matches[0]?.path).toBe("file:///Users/alex/report.md");
    expect(matches[1]?.path).toBe("/tmp/notes.txt");
    expect(matches[2]?.path).toBe("C:\\data\\table.csv");
  });

  it("finds absolute POSIX paths with extensions", () => {
    const text = "Report saved to /Users/alex/workspace/bot/report.md, please review (/tmp/summary.txt).";
    const matches = findLocalFileReferences(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]?.path).toBe("/Users/alex/workspace/bot/report.md");
    expect(matches[1]?.path).toBe("/tmp/summary.txt");
  });

  it("finds Windows drive paths and UNC paths", () => {
    const text = "Output in C:\\Users\\Alex\\docs\\report.md and \\\\server\\share\\data.json.";
    const matches = findLocalFileReferences(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]?.path).toBe("C:\\Users\\Alex\\docs\\report.md");
    expect(matches[1]?.path).toBe("\\\\server\\share\\data.json");
  });

  it("finds paths with parentheses and angle-bracketed paths with spaces", () => {
    const text = "See /tmp/report(1).md and (check /tmp/notes(v2).txt) and <C:\\Program Files\\app\\config.json>.";
    const matches = findLocalFileReferences(text);
    expect(matches).toHaveLength(3);
    expect(matches[0]?.path).toBe("/tmp/report(1).md");
    expect(matches[1]?.path).toBe("/tmp/notes(v2).txt");
    expect(matches[2]?.path).toBe("C:\\Program Files\\app\\config.json");
  });

  it("does not match arbitrary words, web URLs, or math fractions", () => {
    const text = "Visited https://example.com/page.html and 5/2 ratio and and/or test.";
    const matches = findLocalFileReferences(text);
    expect(matches).toHaveLength(0);
  });
});

describe("transformLocalFileLinks", () => {
  it("transforms text nodes containing file references into link nodes", () => {
    const tree = fromMarkdown("Created /Users/alex/report.md for you.") as MdNode;
    transformLocalFileLinks(tree);

    const paragraph = tree.children?.[0];
    expect(paragraph?.children).toBeDefined();
    const children = paragraph!.children!;
    expect(children[0]).toEqual({ type: "text", value: "Created " });
    expect(children[1]).toMatchObject({
      type: "link",
      url: "/Users/alex/report.md",
      children: [{ type: "text", value: "/Users/alex/report.md" }],
    });
    expect(children[2]).toEqual({ type: "text", value: " for you." });
  });

  it("leaves code blocks and inline code untouched", () => {
    const markdown = "`cat /Users/alex/report.md`\n\n```sh\ncat /Users/alex/report.md\n```";
    const tree = fromMarkdown(markdown) as MdNode;
    transformLocalFileLinks(tree);

    const firstPara = tree.children?.[0];
    expect(firstPara?.children?.[0]?.type).toBe("inlineCode");
    const secondBlock = tree.children?.[1];
    expect(secondBlock?.type).toBe("code");
  });
});

describe("isPreviewableDocument", () => {
  it("identifies text/markdown/json documents as previewable", () => {
    expect(isPreviewableDocument("report.md")).toBe(true);
    expect(isPreviewableDocument("/path/to/data.json")).toBe(true);
    expect(isPreviewableDocument("C:\\notes.txt")).toBe(true);
    expect(isPreviewableDocument("log.csv")).toBe(true);
    expect(isPreviewableDocument("script.py")).toBe(true);
  });

  it("does not treat binaries or images as text-previewable documents", () => {
    expect(isPreviewableDocument("archive.zip")).toBe(false);
    expect(isPreviewableDocument("binary.exe")).toBe(false);
    expect(isPreviewableDocument("document.pdf")).toBe(false);
    expect(isPreviewableDocument("photo.png")).toBe(false);
  });
});
