// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../lib/i18n";
import { StreamingReplyContext } from "@/state/live-reply";

const { ChatMarkdown } = await import("./ChatMarkdown");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The fade is CSS: a block fades in when it is first put on the page while the reply streams. So each block must be put
// on the page once, and stay the same element as it grows and finishes, or a shown block would blink.
describe("a streaming reply's blocks fade in once", () => {
  let host: HTMLDivElement;
  let root: Root;
  let shown: Set<Element>;
  const draw = (text: string, streaming = true) =>
    act(() => root.render(createElement(StreamingReplyContext, { value: streaming }, createElement(ChatMarkdown, { text }))));
  const markdown = () => host.querySelector(".chat-md")!;
  /** What this draw put on the page that was not there before: top-level blocks, list items, table rows, code blocks. */
  const added = (text: string) => {
    draw(text);
    const now = [...markdown().querySelectorAll(":scope > *, li, tr, .chat-code-block")];
    const fresh = now.filter((element) => !shown.has(element)).map((element) => `${element.tagName.toLowerCase()}:${(element.textContent ?? "").trim().slice(0, 12)}`);
    shown = new Set(now);
    return fresh;
  };

  beforeEach(() => {
    setLocale("en");
    shown = new Set();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("marks the reply as streaming only while it streams", () => {
    draw("Here is the plan");
    expect(markdown().hasAttribute("data-streaming")).toBe(true);
    draw("Here is the plan.", false);
    expect(markdown().hasAttribute("data-streaming"), "a finished reply never plays the fade").toBe(false);
  });

  it("keeps a paragraph the same element as words arrive and as it finishes", () => {
    expect(added("First ")).toEqual(["p:First"]);
    expect(added("First grows ")).toEqual([]);
    expect(added("First grows\n\nSecond ")).toEqual(["p:Second"]);
    expect(added("First grows\n\nSecond part\n\nThird")).toEqual(["p:Third"]);
  });

  it("keeps a list and a table when they finish", () => {
    expect(added("Lead:\n\n- one\n")).toEqual(["p:Lead:", "ul:one", "li:one"]);
    expect(added("Lead:\n\n- one\n- two\n")).toEqual(["li:two"]);
    expect(added("Lead:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")).toEqual(["div:ab12", "tr:ab", "tr:12"]);
    expect(added("Lead:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n")).toEqual(["tr:34"]);
    expect(added("Lead:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter")).toEqual(["p:After"]);
  });

  it("keeps a code block when its fence closes", () => {
    expect(added("Code:\n\n```js\nconst a = 1;\n")).toEqual(["p:Code:", "div:const a = 1;"]);
    expect(added("Code:\n\n```js\nconst a = 1;\nconst b = 2;\n")).toEqual([]);
    expect(added("Code:\n\n```js\nconst a = 1;\nconst b = 2;\n```\n"), "the closing fence keeps the block").toEqual([]);
    expect(added("Code:\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nAfter ")).toEqual(["p:After"]);
  });

  it("fades with opacity only, once, while streaming, and not with reduced motion", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8").replace(/\r\n/g, "\n");
    const media = css.match(/@media \(prefers-reduced-motion: no-preference\) \{\n {2}\.chat-md\[data-streaming\] > \*,[\s\S]*?\n\}\n/)?.[0];
    expect(media, "the fade sits inside prefers-reduced-motion: no-preference").toBeDefined();
    expect(media).toContain("transition: opacity 600ms ease-out;");
    expect(media).toMatch(/@starting-style \{\s*\.chat-md\[data-streaming\] > \*,\s*\.chat-md\[data-streaming\] \[data-stream-fade\] \{\s*opacity: 0;\s*\}\s*\}/);
    expect(media, "no keyframes: nothing runs after a block is in").not.toMatch(/animation|@keyframes|infinite/);
    expect(css.match(/\.chat-md\[data-streaming\]/g)?.length, "the rule exists only in this block").toBe(4);
  });
});
