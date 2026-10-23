import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import { localizedCard } from "./widget-text";
import type { WidgetPayload } from "../../shared/widget";

afterEach(() => setLocale("en"));

const at = Date.UTC(2026, 9, 22, 11, 30);
const card = (i18n: unknown, extra: Record<string, unknown> = {}): WidgetPayload => ({
  v: 1,
  root: { type: "Card", id: "root", title: "Your brief", caption: "Thursday, October 22", i18n: { title: { key: "brief.card.title" }, caption: { key: "brief.card.date", params: { date: { at, style: "longDate", zone: "UTC" } } } },
    children: [{ type: "Text", id: "n2", value: "8:30 AM · Standup", i18n, ...extra }] },
});

describe("a server card in the person's language", () => {
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
    expect(localizedCard(card({ value: { key: "chat.notice.answerPassed" } }), true).root.children![0]!.value).toBe("Resposta entregue ao trabalho que estava esperando");
    expect(localizedCard(card({ value: { key: "brief.card.meetingLine", params: { title: "Standup" } } }), true).root.children![0]!.value).toBe("8:30 AM · Standup");
    expect(localizedCard(card({ value: { key: "brief.card.meetingLine", params: { time: { at, style: "clock" }, title: "<b>x</b>" } } }), true).root.children![0]!.value).toBe("11:30 UTC · <b>x</b>");
  });
});
