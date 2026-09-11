import { describe, expect, it } from "vitest";

import { remarkThreadRefs, resolveThreadRefs, type ThreadRefCandidate } from "./thread-refs";

const scout = (threadId: string, title: string, activeAt?: number): ThreadRefCandidate =>
  ({ botId: "scout", botName: "Scout", threadId, title, activeAt });
const ada = (threadId: string, title: string, activeAt?: number): ThreadRefCandidate =>
  ({ botId: "ada", botName: "Ada", threadId, title, activeAt });

const threads = [scout("qa", "QA PR 245"), scout("short", "QA"), ada("release", "Release notes"), ada("num", "123")];
const linked = (text: string, list = threads, current?: string) =>
  resolveThreadRefs(text, list, current).filter((span) => span.ref).map((span) => `${span.text}->${span.ref?.threadId}`);

describe("resolveThreadRefs", () => {
  it("links a known title and keeps the surrounding text as plain runs", () => {
    expect(resolveThreadRefs("Done in #Release notes today", threads)).toEqual([
      { text: "Done in " },
      { text: "#Release notes", ref: { botId: "ada", botName: "Ada", threadId: "release", title: "Release notes", ambiguous: false } },
      { text: " today" },
    ]);
  });

  it("prefers the longest known title after the #, so a spaced title beats its own prefix", () => {
    // "QA" is listed before "QA PR 245" on purpose: only longest-first ordering gets this right
    const list = [scout("short", "QA"), scout("qa", "QA PR 245")];
    expect(linked("Opened #QA PR 245 for you", list)).toEqual(["#QA PR 245->qa"]);
    expect(linked("Just #QA here", list)).toEqual(["#QA->short"]);
  });

  it("never links an issue-style number, even when a thread is titled with that number", () => {
    expect(linked("See #123 and #4567", threads)).toEqual([]);
    expect(resolveThreadRefs("See #123", threads)).toEqual([{ text: "See #123" }]);
  });

  it("only links at a word start and only up to a word boundary", () => {
    expect(linked("C#QA PR 245", threads)).toEqual([]);
    expect(linked("&#QA PR 245", threads)).toEqual([]);
    expect(linked("##QA PR 245", threads)).toEqual([]);
    expect(linked("#QA PR 2456 is different", [scout("qa", "QA PR 245")])).toEqual([]);
    // with the shorter "QA" also known, that text still links the longest title that fits
    expect(linked("#QA PR 2456 is different", threads)).toEqual(["#QA->short"]);
    expect(linked("(#QA PR 245) and '#QA PR 245'.", threads)).toEqual(["#QA PR 245->qa", "#QA PR 245->qa"]);
    expect(linked("#QA PR 245", threads)).toEqual(["#QA PR 245->qa"]);
  });

  it("matches case-insensitively but keeps the person's spelling", () => {
    expect(resolveThreadRefs("look at #qa pr 245", threads)).toEqual([
      { text: "look at " },
      { text: "#qa pr 245", ref: expect.objectContaining({ threadId: "qa", title: "QA PR 245" }) },
    ]);
  });

  it("ignores a heading marker, a lone #, and unknown titles", () => {
    expect(linked("# QA PR 245", threads)).toEqual([]);
    expect(linked("ends with #", threads)).toEqual([]);
    expect(linked("#Nothing like this", threads)).toEqual([]);
    expect(resolveThreadRefs("", threads)).toEqual([{ text: "" }]);
    expect(resolveThreadRefs("no refs", [])).toEqual([{ text: "no refs" }]);
  });

  it("links several mentions in one line", () => {
    expect(linked("#QA PR 245 then #Release notes", threads)).toEqual(["#QA PR 245->qa", "#Release notes->release"]);
  });

  it("prefers the current bot's thread when two share a title", () => {
    const shared = [ada("ada-qa", "QA PR 245", 9), scout("scout-qa", "QA PR 245", 1)];
    expect(resolveThreadRefs("#QA PR 245", shared, "scout")[0]?.ref).toMatchObject({ threadId: "scout-qa", ambiguous: false });
    expect(resolveThreadRefs("#QA PR 245", shared, "ada")[0]?.ref).toMatchObject({ threadId: "ada-qa", ambiguous: false });
  });

  it("then prefers the most recently active, and otherwise flags the first as ambiguous", () => {
    const stamped = [ada("older", "QA PR 245", 1), scout("newer", "QA PR 245", 2)];
    expect(resolveThreadRefs("#QA PR 245", stamped, "nobody")[0]?.ref).toMatchObject({ threadId: "newer", ambiguous: false });
    const unstamped = [ada("first", "QA PR 245"), scout("second", "QA PR 245")];
    expect(resolveThreadRefs("#QA PR 245", unstamped)[0]?.ref).toMatchObject({ threadId: "first", botName: "Ada", ambiguous: true });
  });

  it("skips blank titles and duplicate thread records", () => {
    const list = [scout("blank", "   "), scout("qa", "QA PR 245"), scout("qa", "QA PR 245")];
    expect(resolveThreadRefs("#QA PR 245", list)[0]?.ref).toMatchObject({ threadId: "qa", ambiguous: false });
  });
});

describe("remarkThreadRefs", () => {
  type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };
  const text = (value: string): Node => ({ type: "text", value });

  it("splits a paragraph's text into plain and thread-link nodes", () => {
    const tree: Node = { type: "root", children: [{ type: "paragraph", children: [text("See #QA PR 245 now")] }] };
    remarkThreadRefs(threads)()(tree);
    const nodes = tree.children?.[0]?.children ?? [];
    expect(nodes.map((node) => node.type)).toEqual(["text", "threadRef", "text"]);
    expect(nodes[1]).toMatchObject({
      data: { hName: "span", hProperties: { "data-thread-id": "qa", "data-thread-bot": "scout", "data-thread-title": "QA PR 245", "data-thread-ambiguous": "false" } },
      children: [{ type: "text", value: "#QA PR 245" }],
    });
  });

  it("leaves link text and code alone", () => {
    const tree: Node = { type: "root", children: [{ type: "paragraph", children: [
      { type: "link", children: [text("#QA PR 245")] },
      { type: "inlineCode", value: "#QA PR 245" },
    ] }] };
    remarkThreadRefs(threads)()(tree);
    expect(tree.children?.[0]?.children?.map((node) => node.type)).toEqual(["link", "inlineCode"]);
    expect(tree.children?.[0]?.children?.[0]?.children?.[0]).toEqual(text("#QA PR 245"));
  });
});
