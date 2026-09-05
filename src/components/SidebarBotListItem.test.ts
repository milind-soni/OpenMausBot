import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotDeleteMenuItem, BotListItem, botConfirmCopy, currentArchivableBot } from "./Sidebar";

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

  it("shows the Chief of Staff label on its own line under the name", () => {
    const withTitle = renderRow(bot({ chiefOfStaff: true, title: "Developer" }), false);
    expect(withTitle).toContain(">Developer</span>");
    expect(withTitle).toContain("Chief of Staff</span>");
    // the label sits after the name line, never inside it
    expect(withTitle.indexOf("Chief of Staff</span>")).toBeGreaterThan(withTitle.indexOf(">Developer</span>"));

    const withoutTitle = renderRow(bot({ chiefOfStaff: true }), false);
    expect(withoutTitle).toContain("Chief of Staff</span>");
    expect(withoutTitle.indexOf("Chief of Staff</span>")).toBeGreaterThan(withoutTitle.indexOf(">Atlas<"));

    expect(renderRow(bot(), false)).not.toContain("Chief of Staff");
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

  it("marks the avatar with a green presence dot only while the bot works", () => {
    expect(renderRow(bot({ busy: true }), false)).toContain('data-testid="working-dot"');
    expect(renderRow(bot(), false)).not.toContain('data-testid="working-dot"');
    expect(renderRow(bot({ busy: true, activity: "waiting-on-you" }), false)).not.toContain('data-testid="working-dot"');
  });

  it("renders the inline Archive action only when it is available", () => {
    expect(renderRow(bot(), true)).not.toContain('aria-label="Archive Atlas"');
    expect(renderRow(bot(), false)).toContain('aria-label="Archive Atlas"');
  });
});

describe("archive / delete confirmation", () => {
  it("rechecks the latest fleet after a confirmation was opened", () => {
    const snapshot = bot();
    const other = bot({ id: "other" });
    const renamed = bot({ name: "New name" });
    expect(currentArchivableBot([renamed, other], snapshot.id)).toBe(renamed);
    expect(currentArchivableBot([bot({ chiefOfStaff: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([bot({ hidden: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([snapshot], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([other, bot({ id: "third" })], snapshot.id)).toBeUndefined();
  });
  it("archive copy names the bot and says it can be restored", () => {
    const copy = botConfirmCopy("archive", "Juniper");

    expect(copy.title).toContain("Juniper");
    expect(copy.body).toMatch(/restore/i);
    expect(copy.tone).toBe("neutral");
  });

  it("delete copy names the bot and spells out that it is permanent", () => {
    const copy = botConfirmCopy("delete", "Willow");

    expect(copy.title).toContain("Willow");
    expect(copy.body).toMatch(/permanently/i);
    expect(copy.tone).toBe("danger");
  });

  it("renders as an alert dialog with Cancel and the action button", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...botConfirmCopy("delete", "Willow"),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Willow?");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain(">Delete</button>");
    expect(markup).toContain("bg-danger");
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
