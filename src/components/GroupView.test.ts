import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Message } from "@/state/store";

// Replaced whole: its context default reads window.ogb at import time.
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }),
  useCaptionChrome: () => ({}),
}));

import { RoomToolChip } from "./GroupView";

const chip = (patch: Partial<Message> = {}): Message => ({
  id: "chip",
  role: "bot",
  kind: "activity",
  at: 1,
  tool: { name: "Posted in Standup", ok: true },
  ...patch,
});

const render = (message: Message) =>
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(RoomToolChip, { message })));

describe("RoomToolChip", () => {
  it("turns a linked receipt into a button that opens the room it names", () => {
    const markup = render(chip({
      comm: { groupId: "room-standup", withBotId: "scout", withName: "Standup", withColor: "green" },
    }));
    expect(markup).toContain("<button");
    expect(markup).toContain("Posted in Standup");
    expect(markup).toContain('title="Open Standup"');
  });

  it("turns an opened-thread receipt into a button that opens that thread", () => {
    const markup = render(chip({
      tool: { name: "Opened thread #QA PR 245 on Scout", ok: true },
      threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" },
    }));
    expect(markup).toContain("<button");
    expect(markup).toContain("Opened thread #QA PR 245 on Scout");
    expect(markup).toContain('title="Open #QA PR 245"');
  });

  it("opens local details for an ordinary step instead of navigating to a room", () => {
    const markup = render(chip());
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Posted in Standup · Completed · Tool details"');
    expect(markup).not.toContain('title="Open Standup"');
  });

  it("shows a same-room teammate avatar without adding a navigation button", () => {
    const message = chip({
      tool: { name: "Sent to Eli", ok: true },
      comm: { groupId: "here", withBotId: "eli", withName: "Eli", withColor: "green" },
    });
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(RoomToolChip, { message, roomId: "here" })));
    expect(markup).toContain("Sent to Eli");
    expect(markup).toContain('aria-label="Eli"');
    expect(markup).not.toContain("<button");
  });
});
