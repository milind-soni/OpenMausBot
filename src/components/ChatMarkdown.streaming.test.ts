// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { StreamingReplyContext } from "@/state/live-reply";

const parsed = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (options: Parameters<typeof actual.default>[0]) => {
      parsed.push(String(options.children));
      return actual.default(options);
    },
  };
});
const preParsed = vi.hoisted(() => [] as string[]);
vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return {
    ...actual,
    fromMarkdown: (...args: Parameters<typeof actual.fromMarkdown>) => {
      preParsed.push(String(args[0]));
      return actual.fromMarkdown(...args);
    },
  };
});
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
  readAdvancedMode: () => true,
}));

const { ChatMarkdown, clearChatMarkdownCache, normalizeMathDelimiters } = await import("./ChatMarkdown");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a reply's Markdown while it streams", () => {
  let host: HTMLDivElement;
  let root: Root;
  const draw = (text: string, streaming: boolean) =>
    act(() => root.render(createElement(StreamingReplyContext, { value: streaming }, createElement(ChatMarkdown, { text }))));
  // The streaming mark only gates the fade-in; the page under it is what is compared.
  const markup = () => host.innerHTML.replace(' data-streaming=""', "");

  beforeEach(() => {
    setLocale("en");
    clearChatMarkdownCache();
    parsed.length = 0;
    preParsed.length = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("parses each finished block once and only the last block again as text arrives", () => {
    const head = "# Plan\n\nFirst paragraph with **bold**.\n\n";
    draw(`${head}Second`, true);
    expect(parsed).toEqual(["# Plan\n\n", "First paragraph with **bold**.\n\n", "Second"]);
    parsed.length = 0;
    draw(`${head}Second paragraph`, true);
    expect(parsed, "the finished blocks were drawn from the cache").toEqual(["Second paragraph"]);
    parsed.length = 0;
    draw(`${head}Second paragraph grows`, true);
    expect(parsed).toEqual(["Second paragraph grows"]);
  });

  it("draws the same page as the finished reply, so the saved message replaces it without a change", () => {
    for (const text of [
      "# Title\n\nA paragraph with `code` and a [link](https://example.com).\n\n- one\n- two\n\n> quoted\n\nThe end.",
      "Prices: $5 and $10.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
      "Intro\n\n```js\nconst a = 1;\n```\n\nOutro",
    ]) {
      draw(text, true);
      const streamed = markup();
      draw(text, false);
      expect(streamed, text).toBe(markup());
    }
  });

  it("falls back to one parse of the whole text when its syntax ties blocks together", () => {
    const text = "A claim.[^1]\n\nMore.\n\n[^1]: The source.";
    draw(text, true);
    expect(parsed).toEqual([text]);
    const streamed = markup();
    draw(text, false);
    expect(streamed).toBe(markup());
  });

  it("shows an open code fence as plain code with no actions, and offers them once it closes", () => {
    draw("Here:\n\n```ts\nconst a = 1;\nconst b", true);
    expect(parsed, "an open fence is not parsed").toEqual(["Here:\n\n"]);
    const block = host.querySelector(".chat-code-block")!;
    expect(block.textContent).toContain("const a = 1;\nconst b");
    const actions = block.querySelector(".chat-code-actions")!;
    expect(actions.classList.contains("invisible")).toBe(true);
    expect(actions.hasAttribute("inert")).toBe(true);

    draw("Here:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone", true);
    const closed = host.querySelector(".chat-code-actions")!;
    expect(closed.classList.contains("invisible")).toBe(false);
    expect(closed.hasAttribute("inert")).toBe(false);
  });

  it("keeps a fence's actions hidden while it is open inside a parsed block", () => {
    draw("Text right above\n```py\nprint(1)", true);
    const actions = host.querySelector(".chat-code-actions")!;
    expect(actions.hasAttribute("inert")).toBe(true);
    draw("Text right above\n```py\nprint(1)\n```", true);
    expect(host.querySelector(".chat-code-actions")!.hasAttribute("inert")).toBe(false);
  });

  /** Streams `text` in deltas of `step` characters and returns the characters handed to each parser along the way. */
  const stream = (text: string, step: number) => {
    for (let end = step; end < text.length + step; end += step) draw(text.slice(0, end), true);
    const chars = (sources: string[]) => sources.reduce((sum, source) => sum + source.length, 0);
    return { parsed: chars(parsed), longest: Math.max(...parsed.map((source) => source.length)), preParsed: chars(preParsed) };
  };
  const whole = (text: string) => {
    const streamed = markup();
    draw(text, false);
    expect(streamed).toBe(markup());
  };

  it("parses only the item being written of a long list", () => {
    const text = Array.from({ length: 150 }, (_, index) => `- item ${index} with **bold** and \`code\`\n`).join("");
    const work = stream(text, 13);
    expect(work.parsed, "each item is parsed a few times, never the list again").toBeLessThan(text.length * 5);
    expect(work.longest).toBeLessThan(80);
    expect(work.preParsed, "nothing is parsed to normalize or repair").toBe(0);
    expect(host.querySelectorAll("ul").length).toBe(1);
    expect(host.querySelectorAll("li").length).toBe(150);
    whole(text);
  });

  it("parses only the item being written of a long loose list under a lead line", () => {
    const text = `Steps:\n${Array.from({ length: 100 }, (_, index) => `${index + 1}. **Step ${index}**\n\n${" ".repeat(`${index + 1}. `.length)}Its body text.\n\n`).join("")}`;
    const work = stream(text, 13);
    expect(work.parsed).toBeLessThan(text.length * 5);
    expect(work.longest).toBeLessThan(80);
    expect(work.preParsed).toBe(0);
    expect(host.querySelectorAll("ol").length).toBe(1);
    expect(host.querySelectorAll("li > p").length).toBe(200);
    whole(text);
  });

  it("parses only the row being written of a long table", () => {
    const head = "| name | value | note |\n|------|------:|:-----|\n";
    const text = head + Array.from({ length: 150 }, (_, index) => `| row ${index} | ${index * 7} | some \`code\` |\n`).join("");
    const work = stream(text, 13);
    // Each row is parsed under the header, so a parse is three lines long.
    expect(work.parsed).toBeLessThan(text.length * 5 + 150 * 5 * head.length);
    expect(work.longest).toBeLessThan(head.length + 60);
    expect(work.preParsed, "only the header is checked for repair while it arrives").toBeLessThan(head.length * 10);
    expect(host.querySelector("table")!.getAttribute("aria-rowcount")).toBe("151");
    whole(text);
  });

  it("keeps parsing block by block under an HTML line and after display math", () => {
    const prose = Array.from({ length: 60 }, (_, index) => `Paragraph ${index} with **bold** words that keep flowing along.\n\n`).join("");
    for (const text of [`<details>\n\n${prose}`, `$$x^2$$\n\n${prose}`, `Intro\n\n$$\na + b\n$$\n\n${prose}\\[\nc\n\\]\n\n${prose}`]) {
      clearChatMarkdownCache();
      parsed.length = 0;
      preParsed.length = 0;
      const work = stream(text, 13);
      expect(work.parsed, text.slice(0, 12)).toBeLessThan(text.length * 5);
      expect(work.longest, text.slice(0, 12)).toBeLessThan(120);
      whole(text);
    }
  });

  it("normalizes text without math delimiters without parsing it, to the same result", () => {
    const plain = [
      "Plain **bold** and `code` with [a link](https://example.com) and ![an image](a.png).",
      "- one\n- two (with parens) [and brackets]\n\n```sh\nls\n```\n\n| a | b |\n|---|---|\n",
      "Backslashes \\\\ and \\* and a\\b, 100% and #1.",
      "",
    ];
    for (const text of plain) {
      expect(normalizeMathDelimiters(text), text).toBe(text);
      expect(preParsed, text).toEqual([]);
      // With an image map the text is always parsed: the full normalization gives the same text back.
      expect(normalizeMathDelimiters(text, new Map()), text).toBe(text);
      expect(preParsed.splice(0), text).toEqual([text]);
    }
    for (const text of ["Costs $5.", "Inline \\(x\\).", "Display \\[x\\].", "a\u0000b"]) {
      normalizeMathDelimiters(text);
      expect(preParsed.splice(0), text).toEqual([text]);
    }
  });
});
