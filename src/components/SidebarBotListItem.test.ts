import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { BotDeleteMenuItem, BotListItem } from "./Sidebar";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
});

function renderRow(candidate: Bot, archiveDisabled: boolean) {
  return renderToStaticMarkup(createElement(
    StoreProvider,
    null,
    createElement(BotListItem, {
      bot: candidate,
      density: "comfortable",
      onMenu: vi.fn(),
      onArchive: vi.fn(),
      archiveDisabled,
    }),
  ));
}

describe("BotListItem", () => {
  it("leaves the full Chief card as one selectable hit area", () => {
    const markup = renderRow(bot({ chiefOfStaff: true }), false);

    expect(markup).toContain('data-sidebar-bot-row="atlas"');
    expect(markup).not.toContain('aria-label="Archive Atlas"');
  });

  it("moves the Chief of Staff marker beside the title badge when a title is set", () => {
    const withTitle = renderRow(bot({ chiefOfStaff: true, title: "Developer" }), false);
    expect(withTitle).toContain(">Developer</span>");
    expect(withTitle).toContain('aria-label="Chief of Staff"');
    expect(withTitle).not.toContain("> Chief of Staff</span>");

    const withoutTitle = renderRow(bot({ chiefOfStaff: true }), false);
    expect(withoutTitle).toContain("Chief of Staff</span>");
    expect(withoutTitle).not.toContain('aria-label="Chief of Staff"');
  });

  it("shows the bot's title as a badge beside the name", () => {
    const markup = renderRow(bot({ title: "Developer" }), false);

    expect(markup).toContain(">Developer</span>");
    expect(renderRow(bot({ title: "  " }), false)).not.toContain(">Developer</span>");
  });

  it("shows typing dots instead of preview text while the bot works", () => {
    const markup = renderRow(bot({ busy: true }), false);

    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain('class="sr-only">Working…');
  });

  it("renders the inline Archive action only when it is available", () => {
    expect(renderRow(bot(), true)).not.toContain('aria-label="Archive Atlas"');
    expect(renderRow(bot(), false)).toContain('aria-label="Archive Atlas"');
  });
});

describe("bot deletion feedback", () => {
  it("disables the destructive action while persistent computers are checked", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: true,
      onClick: vi.fn(),
    }));

    expect(markup).toContain("Checking computers…");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it("offers Delete again after the check settles", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: false,
      onClick: vi.fn(),
    }));

    expect(markup).toContain(">Delete</button>");
    expect(markup).not.toContain('disabled=""');
  });
});
