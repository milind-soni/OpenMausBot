import { describe, expect, it } from "vitest";
import { chatNotice } from "./chat-notices.ts";
import { waitNoticeText } from "./wait-notice-text.ts";
import type { WaitCondition, WaitRecord } from "./waits.ts";

const HOUR = 3_600_000;
const wait = (condition: WaitCondition): WaitRecord => ({ id: "w", botId: "b", threadId: "t", label: "the build", condition, createdAt: 100, expiresAt: 100 + HOUR, nextCheckAt: 100, errors: 0 });
const cases: Array<[WaitCondition, string, string]> = [
  [{ kind: "url_contains", url: "https://example.test/build", text: "Ready" }, "urlContains", "https://example.test/build now says “Ready”."],
  [{ kind: "url_missing", url: "https://example.test/build", text: "Building", sawText: true }, "urlMissing", "https://example.test/build no longer says “Building”."],
  [{ kind: "file_exists", path: "/fixture/Report.txt" }, "fileExists", "/fixture/Report.txt is there now."],
  [{ kind: "file_missing", path: "/fixture/Report.txt" }, "fileMissing", "/fixture/Report.txt is gone."],
  [{ kind: "file_changed", path: "/fixture/Report.txt", before: null }, "fileChanged", "/fixture/Report.txt changed."],
  [{ kind: "process_running", process: "CaseSensitiveBuild" }, "processRunning", "CaseSensitiveBuild is running."],
  [{ kind: "process_gone", process: "CaseSensitiveBuild" }, "processGone", "CaseSensitiveBuild stopped."],
  [{ kind: "bot_idle", botId: "peer", botName: "Scout", sawBusy: true }, "botIdle", "Scout finished."],
];

describe("wait notice codes", () => {
  it.each(cases)("rebuilds the unchanged fired line for %j", (condition, suffix, detail) => {
    const text = `the build: done. ${detail}`;
    const words = waitNoticeText(wait(condition), { status: "fired", text })!;
    expect(words.key).toBe(`chat.notice.waitDone.${suffix}`);
    expect(chatNotice(words.key as Parameters<typeof chatNotice>[0], words.params)).toBe(text);
  });

  it.each([1, 24])("rebuilds expiration after %i hours", (hours) => {
    const record = wait({ kind: "file_exists", path: "/fixture/Report.txt" });
    record.expiresAt = record.createdAt + hours * HOUR;
    const text = `Stopped waiting for the build after ${hours} hour${hours === 1 ? "" : "s"}.`;
    const words = waitNoticeText(record, { status: "expired", text })!;
    expect(words.key).toBe(hours === 1 ? "chat.notice.waitExpiredOne" : "chat.notice.waitExpiredMany");
    expect(chatNotice(words.key as Parameters<typeof chatNotice>[0], words.params)).toBe(text);
  });

  it("codes only a known reason for a stopped wait, without recognizing English", () => {
    const notice = { status: "stopped", text: "Stopped waiting for the build: Scout no longer exists." } as const;
    const words = waitNoticeText(wait({ kind: "bot_idle", botId: "peer", botName: "Scout", sawBusy: true }), notice)!;
    expect(words.key).toBe("chat.notice.waitBotGone");
    expect(chatNotice("chat.notice.waitBotGone", words.params)).toBe(notice.text);
    expect(waitNoticeText(wait({ kind: "file_missing", path: "/fixture/Report.txt" }), notice)).toBeUndefined();
  });
});
