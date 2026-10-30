// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async importOriginal => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [bot], instances: [{ instanceId: "fake", driverKind: "claude", displayName: "Fake", capabilities: {} }] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-slash-skills", () => ({ useSlashSkills: () => [] }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities(), ready: true }) };
});
import { Composer } from "./Composer";

const bot: Bot = { id: "server-dictation", threadId: "draft-a", name: "Fixture", title: "", description: "", color: "blue", notifications: false, unread: false, busy: false, messages: [], modelSelection: { instanceId: "fake", model: "fake" } };
const draftId = `bot:${bot.id}:${bot.threadId}`;
class Recorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["synthetic speech"]) }); this.onstop?.(); });
  }
}

describe("recording for review in the real composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let complete: (text: string) => void;
  let transcriptions: number;
  let trackStop: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let mediaDescriptor: PropertyDescriptor | undefined;
  const input = () => container.querySelector("textarea")!;
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label)!;
  const click = async (label: string) => act(async () => { button(label).click(); });
  const mount = async (profile = bot) => act(async () => { root.render(createElement(Composer, { bot: profile })); });

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("MediaRecorder", Recorder);
    trackStop = vi.fn();
    getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });
    mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    transcriptions = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/dictation/status") return Response.json({ available: true });
      if (url === "/api/dictation/transcribe") {
        transcriptions++;
        return new Promise<Response>(resolve => { complete = text => resolve(Response.json({ text })); });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    fixture.dispatch.mockClear();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");document.body.append(container);root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    restoreComposerDraft(`bot:${bot.id}:draft-b`, { text: "", attachments: [] });
    if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    delete window.ogb;
    vi.restoreAllMocks();vi.unstubAllGlobals();
  });

  it.each(["web", "windows"])("puts the %s transcript in the draft and sends only on an explicit click", async platform => {
    const native = vi.fn();
    if (platform === "windows") window.ogb = { platform: "win32", speechStart: native } as unknown as typeof window.ogb;
    await mount();
    await click(t("composer.dictation.start"));
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
    expect(transcriptions).toBe(0);
    await click(t("composer.dictation.stop"));
    expect(transcriptions).toBe(1);
    expect(trackStop).toHaveBeenCalled();
    await act(async () => complete("Texto para revisar antes de enviar."));
    expect(input().value).toBe("Texto para revisar antes de enviar.");
    expect(container.textContent).toContain(t("composer.dictation.review"));
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
    await click(t("composer.send.message"));
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "Texto para revisar antes de enviar." }));
    expect(input().value).toBe("");
  });

  it("reports transfer timeouts without labelling the audio invalid or changing the draft", async () => {
    await mount();
    await act(async () => restoreComposerDraft(draftId, { text: "Preserved draft", attachments: [] }));
    await click(t("composer.dictation.start"));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: "upload_timeout" } }, { status: 408 }));
    await click(t("composer.dictation.stop"));
    expect(container.textContent).toContain(t("composer.dictation.serverFailed"));
    expect(container.textContent).not.toContain(t("composer.dictation.invalidAudio"));
    expect(input().value).toBe("Preserved draft");
    expect(trackStop).toHaveBeenCalledOnce();
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
  });

  it("cancels capture without uploading audio or changing the draft", async () => {
    await mount();
    await act(async () => restoreComposerDraft(draftId, { text: "Existing draft", attachments: [] }));
    await click(t("composer.dictation.start"));
    await click(t("composer.dictation.cancel"));
    expect(trackStop).toHaveBeenCalled();expect(transcriptions).toBe(0);expect(input().value).toBe("Existing draft");
  });

  it("rejects a late result after cancel or switching conversations", async () => {
    await mount();
    await click(t("composer.dictation.start"));await click(t("composer.dictation.stop"));
    await click(t("composer.dictation.cancel"));
    await act(async () => complete("Cancelled text"));
    expect(input().value).toBe("");
    await click(t("composer.dictation.start"));await click(t("composer.dictation.stop"));
    await mount({ ...bot, threadId: "draft-b" });
    await act(async () => complete("Old conversation"));
    expect(input().value).toBe("");
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
  });

  it("preserves edits made while transcribing and blocks sending until text is ready", async () => {
    await mount();
    await act(async () => restoreComposerDraft(draftId, { text: "First", attachments: [] }));
    await click(t("composer.dictation.start"));await click(t("composer.dictation.stop"));
    expect(button(t("composer.send.message")).disabled).toBe(true);
    await act(async () => restoreComposerDraft(draftId, { text: "Edited draft:", attachments: [] }));
    await act(async () => complete("Dictated sentence."));
    expect(input().value).toBe("Edited draft: Dictated sentence.");
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
  });

  it("shows microphone refusal without uploading anything", async () => {
    await mount();
    getUserMedia.mockRejectedValueOnce(new DOMException("Not permitted", "NotAllowedError"));
    await click(t("composer.dictation.start"));
    expect(container.textContent).toContain(t("composer.dictation.microphonePermission"));
    expect(transcriptions).toBe(0);expect(input().value).toBe("");
  });

  it("keeps recorded audio when the draft is edited while recording", async () => {
    await mount();
    await click(t("composer.dictation.start"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), "Typed while recording:");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input().value).toBe("Typed while recording:");
    expect(trackStop).not.toHaveBeenCalled();
    await click(t("composer.dictation.stop"));
    await act(async () => complete("Spoken text."));
    expect(input().value).toBe("Typed while recording: Spoken text.");
  });

  it("clears microphone errors when moving to another conversation", async () => {
    await mount();
    getUserMedia.mockRejectedValueOnce(new DOMException("Not permitted", "NotAllowedError"));
    await click(t("composer.dictation.start"));
    expect(container.textContent).toContain(t("composer.dictation.microphonePermission"));
    await mount({ ...bot, threadId: "draft-b" });
    expect(container.textContent).not.toContain(t("composer.dictation.microphonePermission"));
  });

  it("releases a microphone granted after cancellation", async () => {
    await mount();
    let grant!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    await click(t("composer.dictation.start"));
    expect(container.textContent).toContain(t("composer.dictation.starting"));
    await click(t("composer.dictation.cancel"));
    await act(async () => grant({ getTracks: () => [{ stop: trackStop }] }));
    expect(trackStop).toHaveBeenCalledOnce();
    expect(transcriptions).toBe(0);
    expect(input().value).toBe("");
  });

  it("hides capture without HTTPS or a supported recording format", async () => {
    await mount();
    vi.stubGlobal("isSecureContext", false);
    await mount();
    expect(button(t("composer.dictation.start"))).toBeUndefined();
    vi.stubGlobal("isSecureContext", true);
    vi.spyOn(Recorder, "isTypeSupported").mockReturnValue(false);
    await mount();
    expect(button(t("composer.dictation.start"))).toBeUndefined();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops the microphone when leaving a recording conversation", async () => {
    await mount();
    await click(t("composer.dictation.start"));
    await mount({ ...bot, threadId: "draft-b" });
    expect(trackStop).toHaveBeenCalledOnce();
    expect(transcriptions).toBe(0);
    expect(input().value).toBe("");
  });

  it("stops before the strict server duration limit", async () => {
    await mount();
    vi.useFakeTimers();
    try {
      await click(t("composer.dictation.start"));
      await act(async () => { await vi.advanceTimersByTimeAsync(118_000); });
      expect(trackStop).toHaveBeenCalled();
      expect(transcriptions).toBe(1);
      await act(async () => complete("Reviewed text."));
      expect(input().value).toBe("Reviewed text.");
    } finally { vi.useRealTimers(); }
  });

  it("Escape cancels transcription before clearing a quoted reply", async () => {
    await mount();
    const clearReply = vi.fn();
    await act(async () => root.render(createElement(Composer, { bot,
      replyTo: { id: "quoted", role: "user", kind: "text", text: "Quoted message", at: 1 },
      onClearReply: clearReply,
    })));
    await click(t("composer.dictation.start"));
    await click(t("composer.dictation.stop"));
    await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => complete("Cancelled transcription"));
    expect(input().value).toBe("");
    expect(clearReply).not.toHaveBeenCalled();
  });

  it.each(["microphone", "body", "transcribing"])("Escape cancels when focus is on %s rather than the textarea", async focus => {
    await mount();
    await act(async () => restoreComposerDraft(draftId, { text: "Preserved draft", attachments: [] }));
    await click(t("composer.dictation.start"));
    if (focus === "transcribing") await click(t("composer.dictation.stop"));
    if (focus === "microphone") {
      button(t("composer.dictation.stop")).focus();
      expect(document.activeElement).toBe(button(t("composer.dictation.stop")));
    } else {
      (document.activeElement as HTMLElement)?.blur();
      expect(document.activeElement).toBe(document.body);
    }
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => document.activeElement!.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain(t("composer.dictation.cancel"));
    if (focus === "transcribing") await act(async () => complete("Cancelled text"));
    else expect(transcriptions).toBe(0);
    expect(input().value).toBe("Preserved draft");
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
    const idleEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(idleEscape);
    expect(idleEscape.defaultPrevented).toBe(false);
  });

  it("Escape on the body discards a microphone granted after cancellation", async () => {
    await mount();
    let grant!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    await click(t("composer.dictation.start"));
    (document.activeElement as HTMLElement)?.blur();
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.textContent).not.toContain(t("composer.dictation.starting"));
    await act(async () => grant({ getTracks: () => [{ stop: trackStop }] }));
    expect(trackStop).toHaveBeenCalledOnce();
    expect(transcriptions).toBe(0);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("preserves IME composition before cancelling from the microphone button: %j", async composition => {
    await mount();
    await click(t("composer.dictation.start"));
    button(t("composer.dictation.stop")).focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...composition });
    await act(async () => document.activeElement!.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(false);
    expect(trackStop).not.toHaveBeenCalled();
    expect(button(t("composer.dictation.stop"))).toBeDefined();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trackStop).toHaveBeenCalledOnce();
    expect(transcriptions).toBe(0);
  });
});
