// A bubble's markdown must survive the thread list changing (a thread is
// opened or renamed anywhere, a bot is renamed, the selection moves).
// react-markdown builds its elements from the `components` map, so a new map
// means new element types and React throws away every element of the
// message: code highlights, wrap and copy state, spoilers, image previews.
// And a message that cannot hold a thread link has no reason to follow the
// thread list at all. Nor should a re-render or a re-mount of the same text
// parse it again to repair tables and normalize math.
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
// react-markdown is stubbed above, so every parse counted here is one of
// ChatMarkdown's own passes over the text (table repair, math delimiters)
vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) };
});

import { fromMarkdown } from "mdast-util-from-markdown";
import { ChatMarkdown } from "./ChatMarkdown";
import { ThreadRefsContext, type ThreadRefsValue } from "./ThreadRefs";

const qa = { botId: "scout", botName: "Scout", threadId: "qa-245", title: "QA PR 245", activeAt: 1 };
const before: ThreadRefsValue = { threads: [qa], currentBotId: "scout" };
// someone opened a new thread and selected another bot
const after: ThreadRefsValue = {
  threads: [qa, { botId: "ada", botName: "Ada", threadId: "launch", title: "Launch plan", activeAt: 2 }],
  currentBotId: "ada",
};

function markdownProps(refs: ThreadRefsValue, text: string): Record<string, unknown> {
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
    // the heading reads the thread list, so this bubble re-renders when it changes
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
