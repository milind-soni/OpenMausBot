import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PeerCompactRow, PeerExchangeView, PeerOpenedActions } from "./PeerExchange";

const peer = { botId: "L", name: "Liaison", delivery: "coordinate_bots" as const, body: "Long request" };

describe("PeerCompactRow", () => {
  it("is one clickable line with the folded request", () => {
    const html = renderToStaticMarkup(createElement(PeerCompactRow, { preview: "Please check the build and tell me", onOpen: () => {} }));
    expect(html).toContain('data-testid="peer-compact"');
    expect(html).toContain("<button");
    expect(html).toContain("truncate");
    expect(html).toContain("Please check the build and tell me");
    expect(html).toContain('title="Show full message"');
  });
});

describe("PeerOpenedActions", () => {
  it("folds the request again or opens the exchange", () => {
    const html = renderToStaticMarkup(createElement(PeerOpenedActions, { peer, bots: [], botId: "me", botName: "Helper", onFold: () => {} }));
    expect(html).toContain(">Show less<");
    expect(html).toContain('data-testid="peer-view-exchange"');
    expect(html).toContain("View exchange");
  });
});

describe("PeerExchangeView", () => {
  it("lists both bots' lines in order, named, beside the chat", () => {
    const html = renderToStaticMarkup(createElement(PeerExchangeView, {
      lines: [
        { id: "p1", from: "peer", text: "First request", at: 1 },
        { id: "b1", from: "bot", text: "Done with the first", at: 2 },
      ],
      peerName: "Liaison",
      botName: "Helper",
      onClose: () => {},
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Liaison and Helper");
    expect(html).toContain('aria-label="Close"');
    expect(html.indexOf("First request")).toBeLessThan(html.indexOf("Done with the first"));
    expect(html).toContain('data-from="peer"');
    expect(html).toContain('data-from="bot"');
  });
});
