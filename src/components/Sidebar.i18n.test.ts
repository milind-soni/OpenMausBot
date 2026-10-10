// The sidebar is the one screen that is always on display, so it is where an
// untranslated string is most visible. These cover the two shapes the rest of
// the file repeats: a row rendered through t(), and copy built in a helper.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotListItem, BotThreadList, botConfirmCopy, botRowProps, roomDeleteCopy } from "./Sidebar";

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
}) as Bot;

const rowProps = (value: Bot) => botRowProps(initialState, () => {}, value, { density: "comfortable", quiet: false, query: "", onMenu: () => {} });

function renderRow(value: Bot): string {
  return renderToStaticMarkup(createElement(BotListItem, rowProps(value)));
}

afterEach(() => {
  setLocale("en");
});

describe("sidebar rows", () => {
  it("translates a legacy thread's fallback title", () => {
    setLocale("ja");
    const markup = renderToStaticMarkup(createElement(BotThreadList, { ...rowProps(bot()), selected: true }));
    expect(markup).toContain(`title="${t("task.newShort")}"`);
    expect(markup).not.toContain('title="New thread"');
  });

  it("translates the row's own copy and its actions", () => {
    setLocale("pt-br");
    const markup = renderRow(bot({ chiefOfStaff: true, busy: true }));

    expect(markup).toContain("Chefe de gabinete");
    expect(markup).toContain("Trabalhando…");
    expect(markup).not.toContain("Chief of Staff");

    setLocale("ja");
    expect(renderRow(bot())).toContain(`aria-label="${t("sidebar.bot.actions", { name: "Atlas" })}"`);
  });
});

describe("archive / delete confirmation copy", () => {
  it("translates and keeps the bot's name out of the catalog", () => {
    setLocale("pt-br");
    const archive = botConfirmCopy("archive", "Juniper");
    expect(archive.title).toBe("Arquivar Juniper?");
    expect(archive.confirmLabel).toBe("Arquivar");

    const remove = botConfirmCopy("delete", "Willow");
    expect(remove.body).toContain("Willow");
    expect(remove.confirmLabel).toBe("Excluir");
    // a name is never a catalog value, so it survives every language
    setLocale("zh");
    expect(botConfirmCopy("delete", "Willow").title).toBe("删除 Willow？");
  });
});

describe("room delete confirmation copy", () => {
  it("names the group chat and says what goes and what stays", () => {
    const copy = roomDeleteCopy({ name: "Launch plan" });
    expect(copy.title).toBe("Delete Launch plan?");
    expect(copy.body).toContain("Launch plan group chat");
    expect(copy.body).toMatch(/every thread in it/);
    expect(copy.body).toMatch(/routines/);
    expect(copy.body).toMatch(/bots in it are not deleted/);
    expect(copy.body).toMatch(/cannot be undone/);
    expect(copy.confirmLabel).toBe(t("sidebar.room.deleteChannel"));
    expect(copy.tone).toBe("danger");
  });

  it("uses the thread wording for a bot-to-bot room", () => {
    const copy = roomDeleteCopy({ name: "Pen ⇄ Ink", dm: true });
    expect(copy.title).toBe("Delete Pen ⇄ Ink?");
    expect(copy.body).toContain("Pen ⇄ Ink thread");
    expect(copy.body).not.toMatch(/group chat/);
    expect(copy.confirmLabel).toBe(t("sidebar.room.deleteChat"));
  });

  it("renders as a danger alert dialog with Cancel before the delete action", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...roomDeleteCopy({ name: "Launch plan" }),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Launch plan?");
    expect(markup.indexOf(">Cancel</button>")).toBeLessThan(markup.indexOf(">Delete group chat</button>"));
    expect(markup).toContain("bg-danger");
  });

  it("keeps the room's name intact in other languages", () => {
    setLocale("pt-br");
    // untranslated keys fall back to English; the name is never a catalog value
    expect(roomDeleteCopy({ name: "Launch plan" }).title).toContain("Launch plan");
    expect(roomDeleteCopy({ name: "Launch plan" }).confirmLabel).toBe(t("sidebar.room.deleteChannel"));
  });
});
