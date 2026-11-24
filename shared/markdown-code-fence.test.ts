import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";

import { closeUnfinishedCodeFence } from "./markdown-code-fence.ts";

describe("closeUnfinishedCodeFence", () => {
  it.each([
    ["```js\nconst answer = 42;", "\n```"],
    ["~~~js\nconst answer = 42;", "\n~~~"],
    ["````md\n```js\nconst answer = 42;\n```", "\n````"],
    ["~~~~\n```\n~~~", "\n~~~~"],
    ["```", "\n```"],
    ["~~~", "\n~~~"],
    ["```js\nanswer\n", "```"],
    ["```js\nanswer\n\n", "```"],
    ["```js\r\nanswer\r\n", "```"],
    ["~~~js\ranswer\r", "~~~"],
    ["   ```js\n  answer", "\n```"],
    ["```js\nanswer\n``` trailing text", "\n```"],
    ["```js\nanswer\n\t```", "\n```"],
  ])("closes only the unfinished block without changing its code: %j", (text, suffix) => {
    const closed = closeUnfinishedCodeFence(text!);
    expect(closed).toBe(text + suffix!);
    const before = fromMarkdown(text!).children.find((node) => node.type === "code")!;
    const after = fromMarkdown(`${closed}\n\n## Next speaker\n\nA follow-up.`).children;
    expect(after.find((node) => node.type === "code")?.value).toBe(before.value);
    expect(after.find((node) => node.type === "heading")).toMatchObject({ depth: 2, children: [{ type: "text", value: "Next speaker" }] });
  });

  it.each([
    "Plain words with `inline code`.",
    "  Leading spaces and a hard break  \n",
    "```js\nanswer\n```",
    "~~~js\nanswer\n~~~~~  \t\n\n",
    "  ````md\n```js\nanswer\n```\n   ````\n\n",
    "```js\r\nanswer\r\n```\r\n",
    "~~~js\ranswer\r~~~\r",
    "```js\nanswer\n```\n\nDone.",
    "    ```\n    indented code\n",
    "<pre>\n```\nHTML contents\n</pre>",
    "```invalid`info\nordinary text",
  ])("preserves complete Markdown byte for byte: %j", (text) => {
    expect(closeUnfinishedCodeFence(text)).toBe(text);
  });

  it.each([
    "> ```js\n> const answer = 42;",
    "- ```js\n  const answer = 42;",
    "> - ~~~js\n>   const answer = 42;",
  ])("leaves container fences alone when the next speaker ends the container: %j", (text) => {
    expect(closeUnfinishedCodeFence(text)).toBe(text);
    const nodes = fromMarkdown(`${text}\n\n## Next speaker\n\nA follow-up.`).children;
    expect(nodes.find((node) => node.type === "heading")).toMatchObject({ depth: 2, children: [{ type: "text", value: "Next speaker" }] });
    expect(nodes.at(-1)).toMatchObject({ type: "paragraph", children: [{ type: "text", value: "A follow-up." }] });
  });
});
