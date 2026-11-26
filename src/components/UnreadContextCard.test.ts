// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { serializeCitation, type CitationAttachment } from "@/lib/citations";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { ELEVATED_FLOAT } from "./elevated";
import { UnreadContextCard } from "./UnreadContextCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const citation = (id: string, quote: string, comment?: string): CitationAttachment => ({
  kind: "citation",
  version: 1,
  id,
  quote,
  ...(comment ? { comment } : {}),
  source: { ownerType: "bot", ownerId: "bot-1", threadId: "t1", messageId: "m1", start: 0, end: quote.length, prefix: "", suffix: "" },
  size: quote.length,
});

const quoted = (...citations: CitationAttachment[]) => citations.map(serializeCitation).join("\n");
const message = (text: string): Message => ({ id: "u1", role: "user", kind: "text", text, at: Date.parse("2026-11-16T12:00:00Z") });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function draw(element: ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

const card = () => document.querySelector<HTMLElement>('[data-testid="unread-context-card"]');
const blocks = () => [...document.querySelectorAll<HTMLElement>("[data-unread-context-citation]")];

function renderCard(text: string) {
  draw(createElement(UnreadContextCard, { message: message(text), onJump: () => {}, onClose: () => {} }));
}

describe("UnreadContextCard", () => {
  it("shows three citations whole, with no fixed height or clipping around them", () => {
    renderCard(`正文\n\n${quoted(citation("c1", "第一段", "第一条评论"), citation("c2", "第二段"), citation("c3", "第三段"))}`);
    expect(blocks()).toHaveLength(3);
    expect(card()?.textContent).toContain("第三段");
    expect(card()?.textContent).not.toContain(t("chat.unreadContext.moreCitations", { count: 1 }));

    const body = document.querySelector<HTMLElement>("[data-unread-context-body]")!;
    for (const className of ["max-h-32", "overflow-hidden", "overflow-auto", "overflow-y-auto"]) {
      expect(body.className).not.toContain(className);
    }
    expect(document.querySelector("[data-unread-context-text]")?.className).toContain("line-clamp-2");
    for (const quote of document.querySelectorAll("[data-unread-context-quote]")) expect(quote.className).toContain("line-clamp-2");
    expect(document.querySelector("[data-unread-context-comment]")?.className).toContain("line-clamp-2");
  });

  it("gives each of three citations its own long comment, two lines each, with nothing crossing over", () => {
    const comments = [
      "第一条评论：说明为什么要改成可见优先，以及固定六行会切掉半条引用的原因。",
      "第二条评论：这条关注卡片的出现时机，进入未读对话且原消息在首屏外才显示。",
      "第三条评论：这条补充关闭行为，只影响本次停留，离开再进入会重新判断。",
    ];
    renderCard(`正文\n\n${quoted(
      citation("c1", "第一段", comments[0]),
      citation("c2", "第二段", comments[1]),
      citation("c3", "第三段", comments[2]),
    )}`);

    const citations = blocks();
    const rendered = citations.map((block) => block.querySelector<HTMLElement>("[data-unread-context-comment]"));
    expect(citations).toHaveLength(3);
    expect(rendered).toHaveLength(3);
    rendered.forEach((comment, index) => {
      expect(comment).not.toBeNull();
      expect(comment!.className).toContain("line-clamp-2");
      expect(comment!.closest("[data-unread-context-citation]")).toBe(citations[index]);
      expect(comment!.textContent).toContain(comments[index]!);
      for (const other of comments) if (other !== comments[index]) expect(comment!.textContent).not.toContain(other);
    });
  });

  it("keeps the label and time text-only, with the two actions at the end of the same row", () => {
    let jumped = 0;
    let closed = 0;
    draw(createElement(UnreadContextCard, {
      message: message(`正文\n\n${quoted(citation("c1", "第一段", "一条评论"))}`),
      onJump: () => { jumped += 1; },
      onClose: () => { closed += 1; },
    }));

    const rendered = card();
    expect(rendered).not.toBeNull();
    const header = rendered!.querySelector<HTMLElement>("[data-unread-context-header]");
    expect(header).not.toBeNull();
    expect(header!.querySelectorAll("button")).toHaveLength(0);
    expect(header!.textContent).toContain(t("chat.unreadContext.title"));

    const actions = rendered!.querySelector<HTMLElement>("[data-unread-context-actions]");
    expect(actions).not.toBeNull();
    expect(actions!.previousElementSibling).toBe(header);
    expect(actions!.parentElement?.lastElementChild).toBe(actions);
    const buttons = [...actions!.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toBe(t("chat.citation.goToSource"));
    expect(buttons[1]!.getAttribute("aria-label")).toBe(t("common.close"));
    // One pair: the shared quiet variant on the shared button classes, which carry hover, focus, pressed and touch sizes.
    expect(buttons[0]!.className.split(/\s+/)).toEqual(expect.arrayContaining(["ui-button", "ui-button-sm", "ui-button-ghost"]));
    expect(buttons[1]!.className.split(/\s+/)).toEqual(expect.arrayContaining(["ui-icon-button", "ui-button-ghost", "touch:size-10"]));
    for (const button of buttons) expect(button.className.split(/\s+/).some((name) => /^(bg-|border|hover:|active:)/.test(name))).toBe(false);

    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    expect({ jumped, closed }).toEqual({ jumped: 1, closed: 1 });
  });

  it("stays inside the conversation's column on the header's opaque floating surface, with opaque canvas around it and nothing laid over the transcript", () => {
    renderCard("正文");
    const surface = card()!.querySelector<HTMLElement>("[data-unread-context-surface]")!;
    const classes = surface.className.split(/\s+/);
    expect(classes).toContain("chat-column");
    for (const name of ELEVATED_FLOAT.split(" ")) expect(classes).toContain(name);
    expect(classes.some((name) => /^bg-.*\/\d/.test(name))).toBe(false);
    expect(card()!.className.split(/\s+/)).toContain("bg-app");
    expect(card()!.className.split(/\s+/)).toContain("pb-2");
    expect(card()!.querySelector('[aria-hidden="true"]:not(svg)')).toBeNull();
  });

  it("shows the first three of four citations and counts the rest", () => {
    renderCard(`正文\n\n${quoted(citation("c1", "第一段"), citation("c2", "第二段"), citation("c3", "第三段"), citation("c4", "第四段"))}`);
    expect(blocks()).toHaveLength(3);
    expect(card()?.textContent).toContain("第三段");
    expect(card()?.textContent).not.toContain("第四段");
    expect(card()?.textContent).toContain(t("chat.unreadContext.moreCitations", { count: 1 }));
  });
});
