import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CitationAttachment } from "@/lib/citations";
import { ComposerAttachments } from "./ComposerAttachments";
import { SentCitations } from "./CitationUI";

const citation: CitationAttachment = {
  kind: "citation", version: 1, id: "c1", quote: "Your request was not processed.", size: 31,
  source: { ownerType: "bot", ownerId: "b1", threadId: "t1", messageId: "m1", start: 0, end: 31, prefix: "", suffix: "" },
};
const noop = () => {};
const classesOf = (html: string, label: string) => {
  const tag = html.match(new RegExp(`<button[^>]*aria-label="${label}[^"]*"[^>]*>`))?.[0] ?? "";
  return tag.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
};

describe("quote chip in the composer", () => {
  // The composer floats over the transcript, so a see-through chip lets chat text show through it.
  it("sits on the thread colour, so chat text scrolling under the composer does not show through", () => {
    const html = renderToStaticMarkup(createElement(ComposerAttachments, {
      items: [citation], onAdd: noop, onRemove: noop, onChangeCitation: noop, onDisplayInChatBox: noop,
      notice: null, onNotice: noop, uploadImage: async () => null,
    }));
    const chip = classesOf(html, "Open citation");
    const remove = classesOf(html, "Remove citation");
    expect(chip).toContain("bg-app");
    expect(chip).not.toContain("bg-accent/10");
    expect(remove).toContain("bg-app");
  });

  it("keeps the see-through tint on a sent message's quote, which sits on its own surface", () => {
    const html = renderToStaticMarkup(createElement(SentCitations, { citations: [citation], onNavigate: async () => true }));
    const chip = classesOf(html, "Open citation");
    expect(chip).toContain("bg-accent/10");
    expect(chip).not.toContain("bg-app");
  });
});
