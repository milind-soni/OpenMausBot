import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import { localizedCard } from "./widget-text";
import type { WidgetNode, WidgetPayload } from "../../shared/widget";
import { DATA_DIR } from "../../server/config";
import { createBrief } from "../../server/host/brief";
import { closeMessageDb } from "../../server/message-db";
import { Store } from "../../server/store";

afterEach(() => setLocale("en"));

const at = Date.UTC(2026, 9, 22, 11, 30);
const card = (i18n: unknown, extra: Record<string, unknown> = {}): WidgetPayload => ({
  v: 1,
  root: { type: "Card", id: "root", title: "Your brief", caption: "Thursday, October 22", i18n: { title: { key: "brief.card.title" }, caption: { key: "brief.card.date", params: { date: { at, style: "longDate", zone: "UTC" } } } },
    children: [{ type: "Text", id: "n2", value: "8:30 AM · Standup", i18n, ...extra }] },
});

const nodes = (node: WidgetNode): WidgetNode[] => [node, ...(node.children ?? []).flatMap(nodes)];

describe("a server card in the person's language", () => {
  it.each([1, 3])("keeps an Ideas caption's English for %i chats through persistence and translates it for the reader", async (count) => {
    const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief" });
    store.setChiefOfStaff(chief.id);
    const idea = "<b>Save</b> the Friday checklist as a skill";
    const brief = createBrief({
      store, dataDir: mkdtempSync(join(DATA_DIR, "brief-i18n-")), now: () => at, hosted: false, watching: () => true, mainThread: () => chief.threadId,
      threadBusy: () => false, notify: () => {}, runs: () => [], needsYou: () => [], engineName: () => "Claude",
      hostTimeZone: () => "UTC", language: () => "en", session: () => null, address: () => undefined,
      failRun: () => {}, keep: () => {}, items: () => null, ideas: () => ({ ideas: [idea], conversations: count }),
    });
    await brief.active("desktop", "UTC", "en");
    const written = store.messagesFor(chief.threadId).findLast((message) => message.serverCard)!;
    closeMessageDb();
    const persisted = new Store(selection).messagesFor(chief.threadId).find((message) => message.id === written.id)!;
    expect(persisted.widget).toEqual(written.widget);
    const payload = persisted.widget!;
    const original = JSON.stringify(payload);
    const caption = nodes(payload.root).find((node) => node.type === "Caption" && node.value === `Noticed across ${count} chats`)!;
    expect(caption).toBeDefined();
    expect(caption.i18n).toEqual({ value: { key: "brief.row.noticedAcross", params: { count: String(count) } } });
    expect(localizedCard(payload, true)).toBe(payload);
    expect(JSON.stringify(localizedCard(payload, true))).toBe(original);
    if (count === 3) {
      setLocale("pt-br");
      const translated = localizedCard(payload, true);
      expect(translated.root.title).toBe("Seu resumo");
      expect(nodes(translated.root).some((node) => node.value === "Ideias")).toBe(true);
      expect(nodes(translated.root).some((node) => node.value === "Conversas em que isso foi percebido: 3")).toBe(true);
      expect(nodes(translated.root).some((node) => node.value === idea)).toBe(true);
      expect(JSON.stringify(payload)).toBe(original);
      setLocale("en");
      expect(JSON.stringify(localizedCard(payload, true))).toBe(original);
    }
  });

  it("words titles, nested keys and moments in the reader's locale", () => {
    setLocale("pt-br");
    const shown = localizedCard(card({ value: { key: "brief.card.meetingLine", params: { time: { at, style: "clock", zone: "America/Sao_Paulo" }, title: "Standup" } } }), true).root;
    expect(shown.title).toBe("Seu resumo");
    expect(shown.caption).toBe("quinta-feira, 22 de outubro");
    expect(shown.children![0]!.value).toBe("08:30 · Standup");
    const asked = localizedCard(card({ value: { key: "brief.row.asked", params: { name: { key: "brief.part.aBot" } } } }), true).root;
    expect(asked.children![0]!.value).toBe("Um bot perguntou a você");
  });

  it("keeps the English for English, a bot's card, a key from elsewhere or a missing param", () => {
    const i18n = { value: { key: "brief.card.meetingLine", params: { time: { at, style: "clock" }, title: "Standup" } } };
    expect(localizedCard(card(i18n), true).root.children![0]!.value).toBe("8:30 AM · Standup");
    setLocale("pt-br");
    expect(localizedCard(card(i18n), false).root.children![0]!.value).toBe("8:30 AM · Standup");
    expect(localizedCard(card({ value: { key: "settings.title" } }), true).root.children![0]!.value).toBe("8:30 AM · Standup");
    expect(localizedCard(card({ value: { key: "chat.notice.resumingAfterRestart" } }), true).root.children![0]!.value).toBe("Retomando após uma reinicialização");
    expect(localizedCard(card({ value: { key: "brief.card.meetingLine", params: { title: "Standup" } } }), true).root.children![0]!.value).toBe("8:30 AM · Standup");
    expect(localizedCard(card({ value: { key: "brief.card.meetingLine", params: { time: { at, style: "clock" }, title: "<b>x</b>" } } }), true).root.children![0]!.value).toBe("11:30 UTC · <b>x</b>");
  });
});
