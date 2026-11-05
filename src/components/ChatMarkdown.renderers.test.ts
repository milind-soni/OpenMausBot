import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return { ...actual, default: (props: Record<string, unknown>) => { captured.push(props); return null; } };
});
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return { ...react, use: vi.fn(react.use), useContext: vi.fn(react.useContext) };
});
// react-markdown is stubbed above, so every parse counted here is one of ChatMarkdown's own passes.
vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) };
});

import { fromMarkdown } from "mdast-util-from-markdown";
import { ChatMarkdown, clearChatMarkdownCache } from "./ChatMarkdown";
import { ThreadRefsContext, type ThreadRefsValue } from "./ThreadRefs";

const qa = { botId: "scout", botName: "Scout", threadId: "qa-245", title: "QA PR 245", activeAt: 1 };
const before: ThreadRefsValue = { threads: [qa], currentBotId: "scout" };
const after: ThreadRefsValue = {
  threads: [qa, { botId: "ada", botName: "Ada", threadId: "launch", title: "Launch plan", activeAt: 2 }],
  currentBotId: "ada",
};

function markdownProps(refs: ThreadRefsValue, text: string): Record<string, unknown> {
  clearChatMarkdownCache();
  captured.length = 0;
  renderToStaticMarkup(createElement(ThreadRefsContext.Provider, { value: refs },
    createElement(ChatMarkdown, { text, message: { threadId: "t", messageId: "m" } })));
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

function threadListReads(): number {
  const calls = [...vi.mocked(React.use).mock.calls, ...vi.mocked(React.useContext).mock.calls];
  return calls.filter(([context]) => context === ThreadRefsContext).length;
}

describe("ChatMarkdown element renderers", () => {
  beforeEach(() => {
    vi.mocked(React.use).mockClear();
    vi.mocked(React.useContext).mockClear();
  });

  it("hands react-markdown the same renderers whatever the thread list holds", () => {
    const text = "Tracked in #QA PR 245.\n\n```ts\nconst kept = true;\n```";
    const first = markdownProps(before, text);
    const second = markdownProps(after, text);
    expect(second.components).toBe(first.components);
    expect(markdownProps(before, "Another message").components).toBe(first.components);
  });

  it("follows the thread list only for a message that can hold a thread link", () => {
    markdownProps(before, "No thread links here: `code`, **bold** and a [site](https://example.test).");
    expect(threadListReads()).toBe(0);

    markdownProps(before, "## A heading\n\nStill # no thread link.");
    expect(threadListReads()).toBe(0);

    markdownProps(before, "Tracked in #QA PR 245.");
    expect(threadListReads()).toBe(1);

    vi.mocked(React.use).mockClear();
    vi.mocked(React.useContext).mockClear();
    markdownProps(before, "Done in [QA](OpenMausBot://thread/qa-245?bot=scout).");
    expect(threadListReads()).toBe(1);
  });
});

describe("ChatMarkdown normalization", () => {
  beforeEach(() => vi.mocked(fromMarkdown).mockClear());

  it("parses a message for table repair and math once, however often it renders", () => {
    const text = "## Costs\n\n| Step | Cost |\n|---|\n| build | 5 |\n\nArea \\(x^2\\).";
    const first = markdownProps(before, text);
    expect(first.children).toContain("$x^2$");
    expect(fromMarkdown).toHaveBeenCalledTimes(2);

    const second = markdownProps(after, text);
    expect(second.children).toBe(first.children);
    expect(fromMarkdown).toHaveBeenCalledTimes(2);
  });

  it("remembers a bounded number of messages, newest kept", () => {
    const oldest = "The oldest message.";
    markdownProps(before, oldest);
    for (let i = 0; i < 1000; i++) markdownProps(before, `Message ${i}.`);

    vi.mocked(fromMarkdown).mockClear();
    markdownProps(before, "Message 999.");
    expect(fromMarkdown).not.toHaveBeenCalled();
    markdownProps(before, oldest);
    expect(fromMarkdown).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown rendered once per message", () => {
  const draw = (text: string, extra: Record<string, unknown> = {}, refs: ThreadRefsValue = before) => {
    renderToStaticMarkup(createElement(ThreadRefsContext.Provider, { value: refs },
      createElement(ChatMarkdown, { text, message: { threadId: "t", messageId: "m" }, ...extra })));
  };
  const parses = (run: () => void) => {
    captured.length = 0;
    run();
    return captured.length;
  };
  beforeEach(() => clearChatMarkdownCache());

  it("draws a message again from its first rendering", () => {
    const text = "## Plan\n\n- one\n- two with `code`";
    expect(parses(() => draw(text))).toBe(1);
    expect(parses(() => { draw(text); draw(text); })).toBe(0);
    expect(parses(() => draw(`${text}\n- three`))).toBe(1);
  });

  it("renders a message again only when what its plugins read changes", () => {
    const plain = "No names in this one.";
    const named = "Ask @Atlas about it.";
    expect(parses(() => { draw(plain, { mentionPeers: [{ name: "Atlas" }] }); draw(named, { mentionPeers: [{ name: "Atlas" }] }); })).toBe(2);
    // A new peer list with the same names is the same rendering; a renamed or recoloured peer is not.
    expect(parses(() => { draw(plain, { mentionPeers: [{ name: "Juno" }] }); draw(named, { mentionPeers: [{ name: "Atlas" }] }); })).toBe(0);
    expect(parses(() => draw(named, { mentionPeers: [{ name: "Atlas", color: "red" }] }))).toBe(1);
    expect(parses(() => draw(named, { mentionPeers: [{ name: "Atlas", color: "red" }], everyone: true }))).toBe(1);
  });

  it("renders a message that may link a thread again when the thread list changes", () => {
    const text = "Tracked in #QA PR 245.";
    expect(parses(() => draw(text, {}, before))).toBe(1);
    expect(parses(() => draw(text, {}, before))).toBe(0);
    expect(parses(() => draw(text, {}, after))).toBe(1);
    expect(parses(() => draw("Nothing to link.", {}, before))).toBe(1);
    expect(parses(() => draw("Nothing to link.", {}, after))).toBe(0);
  });
});
