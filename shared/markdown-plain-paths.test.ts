import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";

import { linkPlainPaths } from "./markdown-plain-paths.ts";
import { windowsPathDestinations } from "./markdown-windows-paths.ts";

type Node = { type: string; url?: string; value?: string; children?: Node[] };

function links(markdown: string): string[] {
  const tree = fromMarkdown(markdown, { mdastExtensions: [windowsPathDestinations] }) as Node;
  linkPlainPaths(tree, markdown);
  const urls: string[] = [];
  const pending: Node[] = [tree];
  while (pending.length) {
    const node = pending.shift()!;
    if (node.type === "link" && node.url) urls.push(node.url);
    pending.unshift(...(node.children ?? []));
  }
  return urls;
}

describe("plain file paths", () => {
  it("links POSIX, Windows and UNC paths in prose, keeping each one's spelling", () => {
    expect(links("I saved it to /Users/me/reports/q3.md, take a look.")).toEqual(["/Users/me/reports/q3.md"]);
    expect(links(String.raw`Written to C:\Users\me\.openmausbot\report.md.`)).toEqual([String.raw`C:\Users\me\.openmausbot\report.md`]);
    expect(links(String.raw`It's on \\fileserver\team\plans\roadmap.docx now.`)).toEqual([String.raw`\\fileserver\team\plans\roadmap.docx`]);
  });

  it("links a path in backticks, spaces and folders included", () => {
    expect(links("Open `/Users/me/My Reports/q3 final.md`.")).toEqual(["/Users/me/My Reports/q3 final.md"]);
    expect(links(String.raw`See ` + "`" + String.raw`\\fileserver\team\plans` + "`")).toEqual([String.raw`\\fileserver\team\plans`]);
    expect(links("Run `npm test` in `src`.")).toEqual([]);
  });

  it("reads a POSIX path's Markdown escapes as escapes", () => {
    expect(links(String.raw`Saved /tmp/out/my\_notes.md`)).toEqual(["/tmp/out/my_notes.md"]);
  });

  it("leaves prose, web links, code blocks and existing links alone", () => {
    expect(links("Use and/or, see 1/2.5 or /etc alone.")).toEqual([]);
    expect(links("See https://example.com/docs/guide.md for more.")).toEqual([]);
    expect(links("```\ncat /Users/me/notes.md\n```")).toEqual([]);
    expect(links("[the report](/Users/me/report.md)")).toEqual(["/Users/me/report.md"]);
  });
});
