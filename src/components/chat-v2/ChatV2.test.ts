import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { groupChatWork, type TranscriptItem } from "@/lib/activity-runs";
import { citationAttachment, createCitationTextSelector, serializeCitation } from "@/lib/citations";
import { canEditTypedMessage } from "@/lib/transcript-derivations";
import { ExchangeTimeline } from "./ExchangeTimeline";

it("groups adjacent peer records and keeps ordinary messages in place", () => {
  const items: TranscriptItem[] = ["Ada", "Bea", null, "Ada"].map((name, index) => ({
    kind: "message", message: { id: String(index), role: "user", kind: "text", at: 1,
      ...(name && { peerAsk: { botId: name, name } }) },
  }));
  const html = renderToStaticMarkup(createElement(ExchangeTimeline, { items, botId: "host", focusId: null,
    unreadId: null, working: true, render: (_, i) => String(i) }));
  expect(html.match(/<details/g)).toHaveLength(2);
  expect(html).toContain("2 bots");
  expect(html).not.toContain("data-live-entry");
  expect(html).toMatch(/<\/details>(?:<\/div>)*2(?:<div[^>]*>)*<details/);
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
  expect(html).toMatch(/<\/details>(?:<\/div>)*unread(?:<div[^>]*>)*<details/);
});

it("only allows editing plain messages without embedded attachments or citations", () => {
  const message = { id: "typed", role: "user", kind: "text", at: 1, text: "Please review" } as const;
  const selector = createCitationTextSelector("Quoted text", 0, 6)!;
  const citation = citationAttachment({ ownerType: "bot", ownerId: "bot", threadId: "thread", messageId: "source" }, selector);
  expect(canEditTypedMessage(message)).toBe(true);
  expect(canEditTypedMessage({ ...message, text: message.text + '\n\n<attached-file path="/a/b/report.pdf" />' })).toBe(false);
  expect(canEditTypedMessage({ ...message, text: message.text + "\n\n" + serializeCitation(citation) })).toBe(false);
});

it("renders stored user photos above the text and hides their attachment tags", async () => {
  const { Row } = await import("./ChatV2");
  const filename = "422cfa30-c3cf-4e09-9cb8-5fee3ec6c5ca.jpg";
  const photo = `<attached-image path="/data/.openmausbot/attachments/${filename}" name="Photo.jpg" />`;
  const render = (text: string) => renderToStaticMarkup(createElement(Row, {
    message: { id: "photo", at: 1, role: "user", kind: "text", text },
    botId: "bot", botName: "Bot", threadId: "thread", color: "purple",
    busy: false, hasMore: false, transcript: [], ownBubbleStyle: {},
    jumpTo: () => {}, canLoadQuote: false, loadingQuote: false,
  }));
  expect(render(`Dinner\n\n${photo}`)).toMatch(/Photo\.jpg[\s\S]*v2-body[\s\S]*Dinner/);
  expect(render(photo)).not.toMatch(/attached-image|v2-body/);
  const second = photo.replace(filename, "422cfa30-c3cf-4e09-9cb8-5fee3ec6c5cb.jpg");
  expect(render(`${photo}\n${second}`).match(/aspect-square/g)).toHaveLength(2);
});

it("keeps message actions hidden until interaction when a phone reply has a trace", async () => {
  const { Row } = await import("./ChatV2");
  const html = renderToStaticMarkup(createElement(Row, {
    message: { id: "reply", at: 1, role: "bot", kind: "text", text: "Done" },
    digest: { id: "receipt", at: 1, role: "bot", kind: "digest" },
    botId: "bot", botName: "Bot", threadId: "thread", color: "purple",
    busy: false, hasMore: false, transcript: [], phoneLayout: true, ownBubbleStyle: {},
    jumpTo: () => {}, canLoadQuote: false, loadingQuote: false,
  }));
  expect(html).toContain('data-testid="message-actions"');
  expect(html).not.toContain('data-shown="true"');
});

it("keeps one expandable work record through completion and leaves the answer visible", () => {
  const request = { id: "question", role: "user", kind: "text", at: 1000 } as const;
  const progress = { id: "progress", role: "bot", kind: "text", turnId: "turn", at: 1500 } as const;
  const tool = { ...progress, id: "search", kind: "activity", at: 2000, tool: { name: "web_search", ok: true } } as const;
  const answer = { ...progress, id: "answer", turnTerminal: true, at: 4000 };
  expect(groupChatWork([request, progress, tool], true)[2]).toMatchObject({ id: "work:turn", active: true });
  expect(groupChatWork([request, progress, tool, answer], false)).toEqual([
    { kind: "message", message: request },
    expect.objectContaining({ id: "work:turn", active: false, messages: [progress, tool], label: "Worked for 3s" }),
    { kind: "message", message: answer },
  ]);
  const nextRequest = { ...request, id: "next", at: 5000 };
  const history = [request, progress, tool, answer, nextRequest];
  expect(groupChatWork(history, true)).toEqual(
    [request, answer, nextRequest].map(message => ({ kind: "message", message })),
  );
  expect(groupChatWork([request, progress, tool, answer], false, history)).toEqual(
    [request, answer].map(message => ({ kind: "message", message })),
  );
});

it("keeps a question between its surrounding work steps", () => {
  const before = { id: "before", role: "bot", kind: "activity", turnId: "turn", at: 1000, tool: { name: "search" } } as const;
  const question = { id: "question", role: "bot", kind: "options", turnId: "turn", at: 2000 } as const;
  const after = { ...before, id: "after", at: 3000 };
  expect(groupChatWork([before, question, after], false)).toEqual([
    expect.objectContaining({ kind: "turn", messages: [before] }),
    { kind: "message", message: question },
    expect.objectContaining({ kind: "turn", messages: [after] }),
  ]);
});

it("keeps live work when the previous turn and the newest request share a timestamp", () => {
  const previous = { id: "previous", role: "bot", kind: "text", turnId: "old", at: 1000, turnTerminal: true } as const;
  const request = { id: "request", role: "user", kind: "text", at: 1000 } as const;
  const live = { id: "live", role: "bot", kind: "activity", turnId: "new", at: 1000, tool: { name: "search" } } as const;
  expect(groupChatWork([request, live], true, [previous, request])).toEqual([
    { kind: "message", message: request },
    expect.objectContaining({ kind: "turn", turnId: "new", messages: [live], active: true }),
  ]);
});
