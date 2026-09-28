import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";

import { windowsPathDestinations } from "./markdown-windows-paths.ts";

type Node = { type: string; url?: string; value?: string; title?: string | null; children?: Node[] };

function parsed(markdown: string): { urls: string[]; titles: string[]; text: string } {
  const urls: string[] = [];
  const titles: string[] = [];
  let text = "";
  const pending: Node[] = [fromMarkdown(markdown, { mdastExtensions: [windowsPathDestinations] }) as Node];
  while (pending.length) {
    const node = pending.shift()!;
    if (node.url !== undefined) urls.push(node.url);
    if (node.title) titles.push(node.title);
    if (node.type === "text") text += node.value;
    pending.unshift(...(node.children ?? []));
  }
  return { urls, titles, text };
}

describe("Windows path destinations", () => {
  it("keeps a drive path's backslash before punctuation in links, images and definitions", () => {
    expect(parsed([
      "[a](C:\\Users\\Maus\\.openmausbot\\_drafts\\-old\\report.md)",
      "![b](<D:\\.hidden\\chart one.png>)",
      "[c]: C:\\.cache\\notes.md",
    ].join("\n\n")).urls).toEqual([
      "C:\\Users\\Maus\\.openmausbot\\_drafts\\-old\\report.md",
      "D:\\.hidden\\chart one.png",
      "C:\\.cache\\notes.md",
    ]);
  });

  it("still reads escaped backslashes, destination delimiters and character references", () => {
    expect(parsed([
      "[a](C:\\\\Users\\\\Maus\\\\.openmausbot\\\\report.md)",
      "[b](C:\\Apps\\x\\(1\\).md)",
      "[c](<C:\\a\\<b\\>.md>)",
      "[d](C:\\Users\\A&amp;B\\.x.md)",
    ].join("\n\n")).urls).toEqual([
      "C:\\Users\\Maus\\.openmausbot\\report.md",
      "C:\\Apps\\x(1).md",
      "C:\\a<b>.md",
      "C:\\Users\\A&B\\.x.md",
    ]);
  });

  it("leaves other destinations, titles and prose to ordinary Markdown escaping", () => {
    const result = parsed("[a](docs/\\_notes.md \"C:\\.title\") [b](/Users/maus/\\.x) C:\\Users\\Maus\\.openmausbot");
    expect(result.urls).toEqual(["docs/_notes.md", "/Users/maus/.x"]);
    expect(result.titles).toEqual(["C:.title"]);
    expect(result.text).toContain("C:\\Users\\Maus.openmausbot");
  });
});
