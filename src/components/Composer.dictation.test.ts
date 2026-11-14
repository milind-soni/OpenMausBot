// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot], instances: [{
      instanceId: "fake", driverKind: "claude", displayName: "Fake", capabilities: {},
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-slash-skills", () => ({ useSlashSkills: () => [] }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
// A whole capabilities object: Advanced mode (on whenever a saved draft exists) renders the place chip, which reads
// host.platform.
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  const capabilities = { ...initialDesktopCapabilities(), dictation: { available: true, engine: "apple-speech", onDevice: true } };
  return { useDesktopCapabilities: () => ({ capabilities, ready: true }) };
});

import { Composer } from "./Composer";

const bot: Bot = {
  id: "dictation-bot", threadId: "dictation-thread", name: "Fixture", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "fake", model: "fake" },
};
const draftId = `bot:${bot.id}:${bot.threadId}`;
type Transcript = { partial?: boolean; text?: string; error?: string };

describe("native dictation in the real composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let transcript: (line: Transcript) => void;
  let end: (info: { code: number; reason?: string }) => void;
  let speechStop: ReturnType<typeof vi.fn>;
  let speechStart: ReturnType<typeof vi.fn>;

  const input = () => container.querySelector("textarea")!;
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const click = (label: string) => flushSync(() => button(label)!.click());
  const hear = (text: string) => flushSync(() => transcript({ text, partial: true }));

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    speechStop = vi.fn().mockResolvedValue(undefined);
    speechStart = vi.fn().mockResolvedValue(undefined);
    window.ogb = {
      speechStart, speechStop,
      onSpeechTranscript: (cb: typeof transcript) => { transcript = cb; return vi.fn(); },
      onSpeechEnd: (cb: typeof end) => { end = cb; return vi.fn(); },
    } as unknown as typeof window.ogb;
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(Composer, { bot })));
    click(t("composer.dictation.start"));
    expect(speechStart).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    restoreComposerDraft(`bot:${bot.id}:other-thread`, { text: "", attachments: [] });
    delete window.ogb;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not erase dictated text on empty partial/final callbacks", () => {
    hear("ここまで入力した文章。");
    hear("");
    expect(input().value).toBe("ここまで入力した文章。");
    flushSync(() => transcript({ text: "", partial: false }));
    expect(input().value).toBe("ここまで入力した文章。");
  });

  it("stops synchronously on Send and rejects both late speech and end events", () => {
    hear("送信する文章。");
    click(t("composer.send.message"));
    expect(speechStop).toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "送信する文章。" }));
    expect(input().value).toBe("");
    hear("送信する文章。");
    hear("送った後の独り言。");
    flushSync(() => end({ code: 1, reason: "recognition-error" }));
    expect(input().value).toBe("");
    expect(button(t("composer.dictation.start"))).not.toBeNull();
    expect(container.textContent).not.toContain(t("composer.dictation.failed"));
  });

  it("also stops on keyboard Send", () => {
    hear("Enterで送信。");
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(speechStop).toHaveBeenCalled();
    hear("遅れた結果。");
    expect(input().value).toBe("");
  });

  it("accepts multiple recognition results before React paints", () => {
    flushSync(() => {
      transcript({ text: "一", partial: true });
      transcript({ text: "一度に届いた文章。", partial: true });
    });
    expect(input().value).toBe("一度に届いた文章。");
    expect(speechStop).not.toHaveBeenCalled();
  });

  it("keeps the Stop button available after the first transcript and can resume", () => {
    hear("最初の文章。");
    expect(button(t("composer.dictation.stop"))).not.toBeNull();
    click(t("composer.dictation.stop"));
    const late = transcript;
    click(t("composer.dictation.start"));
    flushSync(() => late({ text: "古いセッション", partial: true }));
    expect(input().value).toBe("最初の文章。");
    hear("追加の文章。");
    expect(input().value).toBe("最初の文章。 追加の文章。");
  });

  it("does not overwrite a manual draft edit", () => {
    hear("音声の文章。");
    flushSync(() => restoreComposerDraft(draftId, { text: "手で訂正した文章。", attachments: [] }));
    hear("音声の文章。古い追記。");
    expect(input().value).toBe("手で訂正した文章。");
    expect(speechStop).toHaveBeenCalled();
  });

  it("does not start recognition or copy old transcripts into another thread", async () => {
    hear("元スレッドの文章。");
    const previous = transcript;
    flushSync(() => root.render(createElement(Composer, { bot: { ...bot, threadId: "other-thread" } })));
    await expect.poll(() => input().value).toBe("");
    flushSync(() => previous({ text: "元スレッドの遅い結果。", partial: true }));
    expect(input().value).toBe("");
    expect(speechStart).toHaveBeenCalledOnce();
    flushSync(() => root.render(createElement(Composer, { bot })));
    await expect.poll(() => input().value).toBe("元スレッドの文章。");
  });

  it("retains text when recognition ends in an error", () => {
    hear("失敗しても残す文章。");
    flushSync(() => end({ code: 1, reason: "recognition-error" }));
    hear("");
    expect(input().value).toBe("失敗しても残す文章。");
  });
});
