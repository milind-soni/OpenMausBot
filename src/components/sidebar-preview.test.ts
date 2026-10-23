import { describe, expect, it } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import { botPreview, groupPreview, lastPreviewable, serverCardText } from "./sidebar-preview";
import { setLocale } from "@/lib/i18n";

let at = 0;
const message = (fields: Partial<Message>): Message => ({ id: `m${++at}`, at, role: "bot", kind: "text", ...fields }) as Message;
const screen = () => message({ kind: "screen", png: "frame", mime: "image/jpeg" });
const bot = { id: "ada", name: "Ada", messages: [], busy: false } as unknown as Bot;

describe("sidebar previews", () => {
  it("shows a bot's reply, not the screen frame its computer turn ended with", () => {
    const visible = [message({ role: "user", text: "Paint a sunset" }), message({ text: "I painted a sunset in JS Paint." }), screen()];
    expect(botPreview(bot, visible, [], false)).toBe("I painted a sunset in JS Paint.");
    expect(botPreview(bot, [...visible, message({ kind: "digest", text: "[digest]" }), screen()], [], false)).toBe("I painted a sunset in JS Paint.");
  });

  it("shows nothing for a conversation that holds only screen frames", () => {
    expect(botPreview(bot, [screen(), screen()], [], false)).toBe("");
    expect(lastPreviewable([screen(), message({ kind: "compaction" })])).toBeUndefined();
  });

  it("skips screen frames in a group chat's preview too", () => {
    const group = { id: "g", name: "Room", messages: [message({ text: "Done.", from: { botId: "ada", name: "Ada", color: "green" } }), screen()] } as unknown as Group;
    expect(groupPreview(group, [bot], [], false)).toBe("Ada: Done.");
  });
});

describe("a server card in the sidebar", () => {
  const card = {
    kind: "widget", text: "**Your brief** · Thursday, October 22",
    widget: { v: 1, root: { type: "Card", id: "root", title: "Your brief", caption: "Thursday, October 22",
      i18n: { title: { key: "brief.card.title" }, caption: { key: "brief.card.date", params: { date: { at: Date.UTC(2026, 9, 22, 12), style: "longDate", zone: "UTC" } } } }, children: [] } },
  } as unknown as Message;

  it("previews in the reader's language, and as written in English or for a bot's card", () => {
    expect(serverCardText({ ...card, serverCard: true } as Message)).toBeUndefined();
    setLocale("pt-br");
    try {
      expect(serverCardText({ ...card, serverCard: true } as Message)).toBe("**Seu resumo** · quinta-feira, 22 de outubro");
      expect(serverCardText(card)).toBeUndefined();
    } finally {
      setLocale("en");
    }
  });
});
