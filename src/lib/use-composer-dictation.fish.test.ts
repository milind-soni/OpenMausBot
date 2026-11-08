// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "./i18n";

const fixture = vi.hoisted(() => ({
  config: { savedKeys: { fishAudioKey: { configured: true } } } as unknown,
}));
const fish = vi.hoisted(() => {
  const listeners = { line: undefined as undefined | ((line: unknown) => void), end: undefined as undefined | ((info: unknown) => void) };
  return {
    listeners,
    speechStart: vi.fn(async () => {}),
    speechStop: vi.fn(async () => {}),
    speechFinish: vi.fn(async () => {}),
    onSpeechTranscript: (cb: (line: unknown) => void) => { listeners.line = cb; return () => {}; },
    onSpeechEnd: (cb: (info: unknown) => void) => { listeners.end = cb; return () => {}; },
  };
});
vi.mock("./fish-speech", () => ({ fishSpeech: fish }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: fixture.config } }) }));
vi.mock("@/components/DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("./desktop");
  const capabilities = { ...initialDesktopCapabilities(), dictation: { available: true, engine: "fish-audio", onDevice: false } };
  return { useDesktopCapabilities: () => ({ capabilities, ready: true }) };
});

import { cacheDesktopCapabilities, initialDesktopCapabilities } from "./desktop";
import { useComposerDictation } from "./use-composer-dictation";

type Dictation = ReturnType<typeof useComposerDictation>;

describe("composer dictation through Fish Audio", () => {
  let root: Root;
  let container: HTMLDivElement;
  let dictation: Dictation;
  let typed: string[];

  beforeEach(() => {
    cacheDesktopCapabilities({ ...initialDesktopCapabilities(), dictation: { available: true, engine: "fish-audio", onDevice: false } });
    fixture.config = { savedKeys: { fishAudioKey: { configured: true } } };
    typed = [];
    vi.clearAllMocks();
    const onText = (text: string) => typed.push(text);
    const Probe = () => { dictation = useComposerDictation({ draftId: "d", text: "", onText }); return null; };
    container = document.createElement("div");
    root = createRoot(container);
    flushSync(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    cacheDesktopCapabilities(initialDesktopCapabilities());
  });

  const toggle = () => flushSync(() => dictation.toggle());

  it("finishes and transcribes when the mic is clicked off, keeping the session until its end arrives", () => {
    toggle();
    expect(fish.speechStart).toHaveBeenCalledOnce();
    toggle();
    expect(fish.speechFinish).toHaveBeenCalledOnce();
    expect(fish.speechStop).not.toHaveBeenCalled();
    expect(dictation.recording).toBe(true);
    flushSync(() => fish.listeners.line!({ partial: false, text: "hello" }));
    flushSync(() => fish.listeners.end!({ code: 0, reason: "completed" }));
    expect(typed).toEqual(["hello"]);
    expect(dictation.recording).toBe(false);
    expect(fish.speechStop).not.toHaveBeenCalled();
  });

  it("discards the clip when dictation is stopped some other way", () => {
    toggle();
    flushSync(() => dictation.stop());
    expect(fish.speechStop).toHaveBeenCalledOnce();
    expect(fish.speechFinish).not.toHaveBeenCalled();
    expect(dictation.recording).toBe(false);
  });

  it("shows the message a failed end carries", () => {
    toggle();
    flushSync(() => fish.listeners.end!({ code: 1, reason: "microphone-blocked", message: t("call.live.micBlocked") }));
    expect(dictation.speechError).toBe(t("call.live.micBlocked"));
  });

  it("says the recording stopped early when the end was cut off", () => {
    toggle();
    flushSync(() => fish.listeners.line!({ partial: false, text: "hello" }));
    flushSync(() => fish.listeners.end!({ code: 0, reason: "interrupted" }));
    expect(typed).toEqual(["hello"]);
    expect(dictation.recording).toBe(false);
    expect(dictation.speechError).toBe(t("composer.dictation.cutOff"));
  });

  it("is not ready without a saved Fish Audio key", () => {
    expect(dictation.ready).toBe(true);
    fixture.config = null;
    flushSync(() => root.render(createElement(() => { dictation = useComposerDictation({ draftId: "d", text: "", onText: () => {} }); return null; })));
    expect(dictation.ready).toBe(false);
  });
});
