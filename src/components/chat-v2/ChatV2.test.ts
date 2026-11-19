import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { TranscriptItem } from "@/lib/activity-runs";
import { citationAttachment, createCitationTextSelector, serializeCitation } from "@/lib/citations";
import { canEditTypedMessage } from "@/lib/transcript-derivations";
import { ExchangeTimeline } from "./ExchangeTimeline";

it("groups adjacent peer records and keeps ordinary messages in place", () => {
  const items: TranscriptItem[] = ["Ada", "Bea", null, "Ada"].map((name, index) => ({
    kind: "message", message: { id: String(index), role: "user", kind: "text", at: 1,
      ...(name && { peerAsk: { botId: name, name } }) },
  }));
  const html = renderToStaticMarkup(createElement(ExchangeTimeline, { items, botId: "host", focusId: null,
    unreadId: null, render: (_, i) => String(i) }));
  expect(html.match(/<details/g)).toHaveLength(2);
  expect(html).toContain("2 bots");
  expect(html).toMatch(/<\/details>2<details/);
});

it("keeps the first unread peer record outside a collapsed exchange", () => {
  const items: TranscriptItem[] = ["read", "unread", "later"].map(id => ({
    kind: "message", message: { id, role: "user", kind: "text", at: 1,
      peerAsk: { botId: "ada", name: "Ada" } },
  }));
  const html = renderToStaticMarkup(createElement(ExchangeTimeline, {
    items, botId: "host", focusId: null, unreadId: "unread",
    render: item => item.kind === "message" ? item.message.id : null,
  }));
  expect(html).toContain("</details>unread<details");
});

it("only allows editing plain messages without embedded attachments or citations", () => {
  const message = { id: "typed", role: "user", kind: "text", at: 1, text: "Please review" } as const;
  const selector = createCitationTextSelector("Quoted text", 0, 6)!;
  const citation = citationAttachment({ ownerType: "bot", ownerId: "bot", threadId: "thread", messageId: "source" }, selector);
  expect(canEditTypedMessage(message)).toBe(true);
  expect(canEditTypedMessage({ ...message, text: message.text + '\n\n<attached-file path="/a/b/report.pdf" />' })).toBe(false);
  expect(canEditTypedMessage({ ...message, text: message.text + "\n\n" + serializeCitation(citation) })).toBe(false);
});
