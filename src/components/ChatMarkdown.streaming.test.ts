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
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
  readAdvancedMode: () => true,
}));

const { ChatMarkdown, clearChatMarkdownCache } = await import("./ChatMarkdown");

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
    parsed.length = 0;
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
});
