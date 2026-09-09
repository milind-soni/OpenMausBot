// The sidebar is the one screen that is always on display, so it is where an
// untranslated string is most visible. These cover the two shapes the rest of
// the file repeats: a row rendered through t(), and copy built in a helper.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { StoreProvider, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { BotListItem, BotThreadList, botConfirmCopy } from "./Sidebar";

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

function renderRow(value: Bot): string {
  return renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(BotListItem, {
        bot: value,
        density: "comfortable",
        onMenu: () => {},
      }),
    ),
  );
}

afterEach(() => {
  setLocale("en");
});

describe("sidebar rows", () => {
  it("translates a legacy thread's fallback title", () => {
    setLocale("ja");
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(BotThreadList, { bot: bot(), selected: true })));
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
