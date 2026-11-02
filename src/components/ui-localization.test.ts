import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { StoreProvider, type Message } from "@/state/store";
import { ComposerAttachments } from "./ComposerAttachments";
import { GoalRunCard } from "./GoalRunCard";
import { OptionCard } from "./OptionCard";
import { MoreMenu } from "./browser/MoreMenu";

afterEach(() => setLocale("en"));

it("keeps an engine's own name when it matches a reserved display phrase", () => {
  setLocale("zh");
  const message: Message = { id: "named-engine", role: "bot", kind: "options", at: 1, card: {
    title: "User supplied title", subtitle: "", options: ["Not now"], fixedOptions: true,
    quotaSwitch: { engines: [{ instanceId: "custom", name: "Not now" }] },
  } };
  const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(OptionCard, { botId: "bot", message })));
  expect(html).toContain(">Not now<");
  expect(message.card!.options).toEqual(["Not now"]);
});

it.each([
  ["en", "Fill the panel", "Working", "Not now", "PASTED"],
  ["zh", "填满面板", "工作中", "暂时不用", "已粘贴"],
  ["zh-tw", "填滿面板", "工作中", "暫時不要", "已貼上"],
])("renders %s from live labels while preserving user data and wire values", (locale, fill, working, notNow, pasted) => {
  setLocale(locale);
  const menu = renderToStaticMarkup(createElement(MoreMenu, {
    stream: true, ready: true, typing: true, setting: { mode: "fill" }, zoom: 1, pip: null,
    onViewport() {}, onZoom() {}, onPip() {}, onType() {}, onSecret() {}, onReconnect() {}, onRestart() {},
  }));
  expect(menu).toContain(fill);
  expect(menu).toContain("1280×800");
  const goal: Message = { id: "goal", role: "bot", kind: "text", at: 1, goalRun: {
    runId: "run", goal: "User supplied goal", status: "working", coordinatorBotId: "bot", coordinatorName: "Scout",
    turnCount: 0, maxTurns: 4, startedAt: 1,
  } };
  const run = renderToStaticMarkup(createElement(GoalRunCard, { message: goal }));
  expect(run).toContain(working);
  expect(run).toContain("User supplied goal");
  const card: Message = { id: "offer", role: "bot", kind: "options", at: 1, card: {
    title: "Keep this title", subtitle: "", options: ["Codex", "Not now"], requestId: "quota", fixedOptions: true,
    quotaSwitch: { engines: [{ instanceId: "codex", name: "Codex" }] },
  } };
  const renderCard = () => renderToStaticMarkup(createElement(StoreProvider, null, createElement(OptionCard, { botId: "bot", message: card })));
  expect(renderCard()).toContain(notNow);
  card.card!.answered = "answer";
  card.card!.answeredText = "Not now";
  expect(renderCard()).toContain(notNow);
  expect(card.card!.answeredText).toBe("Not now");
  expect(card.card!.options).toEqual(["Codex", "Not now"]);
  const attachments = renderToStaticMarkup(createElement(ComposerAttachments, {
    items: [{ kind: "paste", id: "paste", text: "User text", size: 9, lines: 1 }], notice: null,
    onAdd() {}, onRemove() {}, onChangeCitation() {}, onDisplayInChatBox() {}, onNotice() {},
    uploadImage: async () => null,
  }));
  expect(attachments).toContain(pasted);
  expect(attachments).toContain("lucide-clipboard-paste");
});
