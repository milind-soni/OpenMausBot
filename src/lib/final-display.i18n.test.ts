import { afterEach, expect, it } from "vitest";
import { setLocale } from "./i18n";
import * as ready from "./ready-bots";
import type { ReadyBot } from "./ready-bots";
import * as stream from "./browser-stream-client";

afterEach(() => { setLocale("en"); });

it("final gallery display localizes a separate copy while retaining the preset and its searchable identity", () => {
  setLocale("zh");
  const bot = ready.readyBot("assistant")!;
  const before = structuredClone(bot);
  const display = (ready as unknown as { readyBotDisplay?: (bot: ReadyBot) => { name: string; title: string; description: string; prompt: string } })
    .readyBotDisplay?.(bot) ?? { name: bot.name, title: bot.title, description: bot.description, prompt: bot.tryAsking[0]! };
  expect(display.title).toBe("通用助手");
  expect(display.name).toBe("助手");
  expect(ready.matchesReadyBot({ ...bot, ...display }, "通用助手")).toBe(true);
  expect(ready.matchesReadyBot(bot, "General assistant")).toBe(true);
  expect(Object.keys(display).sort()).toEqual(["description", "name", "prompt", "title"]);
  expect(bot).toEqual(before);
  expect(ready.readyBot("assistant")).toBe(bot);
});

const restartNotice = "The browser could not restart. Wait for active work to finish and try again.";
const noticeDisplay = (message: string) => (stream as unknown as { browserRestartNoticeText?: (message: string) => string })
  .browserRestartNoticeText?.(message) ?? message;

it.each([
  ["zh", "浏览器未能重启。请等待正在进行的工作结束后重试。"],
  ["zh-tw", "瀏覽器未能重新啟動。請等待進行中的工作結束後重試。"],
  ["en", restartNotice],
])("controlled restart notice follows %s in the viewer", (locale, expected) => {
  setLocale(locale);
  expect(noticeDisplay(restartNotice)).toBe(expected);
});

it("controlled restart notice leaves similar and unknown diagnostics unchanged", () => {
  setLocale("zh-tw");
  for (const message of [restartNotice + " Provider detail.", restartNotice + " ", restartNotice.replace("restart", "start"), "Unknown driver error"]) {
    expect(noticeDisplay(message)).toBe(message);
  }
});
