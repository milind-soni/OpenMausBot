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

function renderRow(candidate: Bot) {
  return renderToStaticMarkup(createElement(
    StoreProvider,
    null,
    createElement(BotListItem, {
      bot: candidate,
      density: "comfortable",
      onMenu: vi.fn(),
    }),
  ));
}

describe("BotListItem", () => {
  it("offers a direct New folder button and keyboard-accessible bot menu independently of New thread", () => {
    const markup = renderRow(bot());
    expect(markup).toContain('aria-label="New folder under Atlas"');
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain('aria-haspopup="menu"');
  });
  it("keeps the native thread toggle beside, not inside, the selectable bot row", () => {
    const markup = renderRow(bot());
    expect(markup).toContain('role="button" tabindex="0"');
    expect(markup).toContain('</div><button type="button" aria-label="Expand Atlas threads" aria-expanded="false"');
    const toggle = markup.match(/<button[^>]*aria-label="Expand Atlas threads"[^>]*>/)?.[0];
    expect(toggle).toContain("focus-visible:ring-1");
    expect(toggle).not.toContain("hover:bg-");
  });

  it("leaves the full Chief card as one selectable hit area", () => {
    const markup = renderRow(bot({ chiefOfStaff: true }));

    expect(markup).toContain('data-sidebar-bot-row="atlas"');
    expect(markup).not.toContain('aria-label="Archive Atlas"');
  });

  it("shows the Chief of Staff label on its own line under the name", () => {
    const withTitle = renderRow(bot({ chiefOfStaff: true, title: "Developer" }));
    expect(withTitle).toContain("Chief of Staff</span>");
    // the label sits after the name line, never inside it
    expect(withTitle.indexOf("Chief of Staff</span>")).toBeGreaterThan(withTitle.indexOf(">Atlas<"));

    const withoutTitle = renderRow(bot({ chiefOfStaff: true }));
    expect(withoutTitle).toContain("Chief of Staff</span>");
    expect(withoutTitle.indexOf("Chief of Staff</span>")).toBeGreaterThan(withoutTitle.indexOf(">Atlas<"));

    expect(renderRow(bot())).not.toContain("Chief of Staff");
  });

  // matches the title line's own class list (see Sidebar.tsx) — used to
  // assert the marker element itself is present or absent, since checking
  // for the title text alone can pass by accident when there's no title.
  const titleLine = /<div class="truncate text-\[11px\][^"]*">([^<]*)<\/div>/;

  it("shows the bot's title on its own line above the name, not a badge beside it", () => {
    // #866 / #871: a badge next to the name always had to fight the name for
    // width — a long name crushed the badge, and a long title crushed a long
    // name right back. Its own line above the name never competes with it.
    const markup = renderRow(bot({ title: "Developer" }));

    expect(titleLine.exec(markup)?.[1]).toBe("Developer");
    expect(markup.indexOf(">Developer<")).toBeLessThan(markup.indexOf(">Atlas<"));
    // the rename hint is unrelated to the bot's title
    expect(markup).toContain('title="Double-click to rename"');

    expect(titleLine.test(renderRow(bot()))).toBe(false);
    expect(titleLine.test(renderRow(bot({ title: "  " })))).toBe(false);
  });

  it("keeps the title line's own truncate class instead of a shared-line width cap", () => {
    // renderToStaticMarkup keeps the full text regardless of CSS, so this
    // can't observe an actual ellipsis — it asserts the title line still
    // carries `truncate` (so a too-long title clips on its own line) and,
    // unlike the #871 badge, never a max-width cap shared with the name.
    const longTitle = "Meta-Agent — opensource team maintainer";
    const markup = renderRow(bot({ name: "Team Maintainer", title: longTitle }));

    expect(titleLine.exec(markup)?.[1]).toBe(longTitle);
    expect(markup).toContain(">Team Maintainer<");
    expect(markup).not.toContain("max-w-[45%]");
  });

  it("shows typing dots instead of preview text while the bot works", () => {
    const markup = renderRow(bot({ busy: true }));

    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain('class="sr-only">Working…');
  });

  it("marks the avatar with a green presence dot only while the bot works", () => {
    expect(renderRow(bot({ busy: true }))).toContain('data-testid="working-dot"');
    expect(renderRow(bot())).not.toContain('data-testid="working-dot"');
    expect(renderRow(bot({ busy: true, activity: "waiting-on-you" }))).not.toContain('data-testid="working-dot"');
  });

  it("keeps Archive in the Actions menu and reveals quiet row controls on focus as well as hover", () => {
    const markup = renderRow(bot());
    expect(markup).not.toContain('aria-label="Archive Atlas"');
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain("group-focus-within:opacity-100");
    expect(markup).toContain("group-hover:pointer-events-auto");
    expect(markup).not.toContain("pr-[92px]");
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
