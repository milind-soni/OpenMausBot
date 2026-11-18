// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { StreamingReplyContext } from "@/state/live-reply";

const parsed = vi.hoisted(() => [] as string[]);
const normalizingParses = vi.hoisted(() => [] as string[]);
const splitting = vi.hoisted(() => ({ on: true }));
vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return {
    ...actual,
    fromMarkdown: (...args: Parameters<typeof actual.fromMarkdown>) => {
      normalizingParses.push(String(args[0]));
      return actual.fromMarkdown(...args);
    },
  };
});
// Off, a streaming reply is parsed whole: what the pieces must draw.
vi.mock("@/lib/markdown-stream-blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markdown-stream-blocks")>();
  return {
    ...actual,
    splitMarkdownBlocks: (text: string) => splitting.on ? actual.splitMarkdownBlocks(text) : null,
    splitStreamingBlock: (block: string) => splitting.on ? actual.splitStreamingBlock(block) : null,
  };
});
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
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
  readAdvancedMode: () => true,
}));

const { ChatMarkdown, clearChatMarkdownCache, ensureChatKatex } = await import("./ChatMarkdown");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a reply's Markdown while it streams", () => {
  let host: HTMLDivElement;
  let root: Root;
  const draw = (text: string, streaming: boolean) =>
    act(() => root.render(createElement(StreamingReplyContext, { value: streaming }, createElement(ChatMarkdown, { text }))));
  const markup = () => host.innerHTML;

  beforeEach(() => {
    setLocale("en");
    clearChatMarkdownCache();
    splitting.on = true;
    parsed.length = 0;
    normalizingParses.length = 0;
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

  it("parses each finished list item once and only the item being written again as text arrives", () => {
    const head = "Here is the plan:\n- first **step**\n- second `step`\n";
    draw(`${head}- thi`, true);
    expect(parsed).toEqual(["- first **step**", "- second `step`", "- thi", "Here is the plan:\n"]);
    parsed.length = 0;
    draw(`${head}- third`, true);
    expect(parsed, "the finished items were kept").toEqual(["- third"]);
    parsed.length = 0;
    draw(`${head}- third step\n- fo`, true);
    expect(parsed).toEqual(["- third step", "- fo"]);
  });

  it("parses each finished table row once, after the table's head, and only the row being written again", () => {
    const table = "| Name | Value |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |\n";
    draw(`${table}| c`, true);
    parsed.length = 0;
    draw(`${table}| c | 3`, true);
    expect(parsed).toEqual(["| Name | Value |\n| :--- | ---: |\n| c | 3"]);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(normalizingParses, "the growing table is not parsed again to repair it").toEqual([]);
  });

  it("cuts a reply around an HTML page in a code fence", () => {
    const page = "```html\n<!doctype html>\n<script>\nlet a = 1;\n\nlet b = 2;\n</script>\n```\n\n";
    draw(`${page}After`, true);
    parsed.length = 0;
    draw(`${page}After the page`, true);
    expect(parsed).toEqual(["After the page"]);
  });

  it("parses whole the list or table it cannot cut", () => {
    for (const text of ["- one\n- two\n\n- loose", "- costs $5\n- and $10", "Intro\n2. two\n3. three"]) {
      parsed.length = 0;
      draw(text, true);
      expect(parsed.map((source) => source.replaceAll("\\$", "$")), text).toEqual([text]);
    }
  });

  it("does not parse text again to normalise math it does not have", () => {
    draw("A **plain** reply with `code` and a [link](https://example.com).", false);
    expect(normalizingParses).toEqual([]);
    draw("Costs $5 and $x^2$.", false);
    expect(normalizingParses).toEqual(["Costs $5 and $x^2$."]);
  });
});

// Its second fence is closed only by the next item, so it shows as still open until the reply is finished.
const FENCE_CLOSED_BY_ITEM = "1. Install:\n   ```bash\n   npm i\n   ```\n2. Run:\n   ```\n   npm start\n3. Done";
const CORPUS = [
  "Here is the plan:\n- first step with **bold**\n- second `code` step\n- third [link](https://example.com)\n\nDone.",
  "Steps:\n\n1. one\n2. two\n3. three\n",
  "- a\n  - a1\n  - a2\n- b\n  1. b1\n- c",
  "- [ ] todo\n- [x] done\n- plain",
  "- one\n- two\n\n- three",
  FENCE_CLOSED_BY_ITEM,
  "- costs $5 now\n- then $10 later\n- x$y and z$ w",
  "- 123\n- \u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd\n- 456",
  "- item one\nlazy line\n- item two",
  "- a\n* b\n+ c",
  "- a\n- b\n* * *\nafter",
  "- a\n# Heading\n- b",
  "Intro\n2. two\n3. three",
  "# Title\n- a\n- b",
  "| Name | Value |\n| :--- | ---: |\n| a | 1 |\n| b **bold** | `c|d` |\n| e \\| f | 3 |\n\nAfter",
  "| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n| x",
  "Intro\n| a | b |\n|---|\n| 1 | 2 |",
  "| a | b |\n| - | - |\n| 1 | 2 |\nbar\n| 3 | 4 |",
  "| # | 1 |\n| - | - |\n| 2 | \u05e9\u05dc\u05d5\u05dd |",
  "<details>\n<summary>More</summary>\n\nhidden **text**\n\n</details>\n\nAfter",
  "Before\n\n<!-- note\n\nstill comment -->\n\nAfter",
  "Formula:\n\n$$\nx^2 + y^2\n\n= z^2\n$$\n\nAnd $$a+b$$ inline.\n\n- item $5",
  "Intro paragraph.\n\nA claim.[^1] Another.[^2]\n\n- list item\n- another\n\n[^1]: First source.\n[^2]: Second.",
  "# Title\n\nSome prose with *emphasis*.\n\n| h1 | h2 |\n| -- | -- |\n| r1 | r2 |\n| r3 | r4 |\n\n- x\n- y\n\n```js\nconst a = 1;\n```\n\nEnd.",
  "- a | b\n- c | d\n- e",
  "Look:\n+ plus one\n+ plus two\n\n10) ten\n11) eleven",
  " - a\n- b\n- c",
  "<div>\n- a\n- b",
  "<details>\n<summary>S</summary>\n- a\n- b\n</details>",
  "<br>\n- a\n- b",
  "a | b\n- | -\n- c",
  "Use `<script>` and `<!-- -->` in a line.\n\nNext\n\n- a\n- b",
  "```html\n<!doctype html>\n<html>\n<script>\nlet a = 1;\n\nlet b = 2;\n</script>\n</html>\n```\n\nAfter\n\n- x\n- y",
  "> quote\n> <!-- note\n\nstill -->\n\nEnd",
  "-\tx\n- b\n- c",
];

describe("a reply streamed one character at a time", () => {
  it("draws at every point what parsing the text so far whole draws, and the finished reply at the end", async () => {
    await ensureChatKatex();
    const roots = [document.createElement("div"), document.createElement("div")].map((element) => {
      document.body.append(element);
      return { element, root: createRoot(element) };
    });
    const [streamed, whole] = roots as [typeof roots[0], typeof roots[0]];
    const drawIn = (target: typeof streamed, text: string, streaming: boolean, split: boolean) => {
      splitting.on = split;
      act(() => target.root.render(createElement(StreamingReplyContext, { value: streaming }, createElement(ChatMarkdown, { text }))));
    };
    for (const text of CORPUS) {
      for (let end = 1; end <= text.length; end++) {
        const prefix = text.slice(0, end);
        drawIn(streamed, prefix, true, true);
        drawIn(whole, prefix, true, false);
        expect(streamed.element.innerHTML, JSON.stringify(prefix)).toBe(whole.element.innerHTML);
      }
      const lastStreamed = streamed.element.innerHTML;
      drawIn(streamed, text, false, true);
      if (text !== FENCE_CLOSED_BY_ITEM) expect(lastStreamed, `finished: ${text}`).toBe(streamed.element.innerHTML);
    }
    for (const { element, root } of roots) {
      act(() => root.unmount());
      element.remove();
    }
  }, 120_000);
});

