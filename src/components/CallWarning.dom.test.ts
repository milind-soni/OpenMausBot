// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentCall, endCall, startCall } from "@/lib/call";
import { t } from "@/lib/i18n";
import { BotEditorStore, initialState, type Bot, type Group } from "@/state/store";
import { CallOverlay } from "./CallView";
import { GroupCallOverlay } from "./GroupCallView";

type Bridge = NonNullable<Window["ogb"]>;
type SpeechEndListener = Parameters<Bridge["onSpeechEnd"]>[0];

const bot: Bot = {
  id: "ada", threadId: "ada-thread", name: "Ada", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId: "codex", model: "m" },
};
const group: Group = {
  id: "room", threadId: "room-thread", name: "Standup", memberIds: [bot.id],
  defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false, createdAt: 1, messages: [],
};

describe.each([
  { name: "one-to-one", targetId: bot.id, overlay: createElement(CallOverlay, { bot }) },
  { name: "room", targetId: group.id, overlay: createElement(GroupCallOverlay, { group, members: [bot] }) },
])("$name call overlay", ({ targetId, overlay }) => {
  let root: Root;
  let container: HTMLDivElement;
  let speechEnd: SpeechEndListener;
  const speechStart = vi.fn(async () => {});
  const speechStop = vi.fn(async () => {});
  const dismiss = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.notice.dismiss")}"]`);
  const retry = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === t("call.turns.tryMicrophone"));
  const fail = (info: Parameters<SpeechEndListener>[0]) => flushSync(() => speechEnd(info));

  beforeEach(() => {
    speechStart.mockClear();
    speechStop.mockClear();
    startCall(targetId);
    window.ogb = {
      platform: "darwin",
      speechStart,
      speechStop,
      onSpeechTranscript: () => () => {},
      onSpeechEnd: (listener: SpeechEndListener) => { speechEnd = listener; return () => {}; },
    } as unknown as Bridge;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const value = {
      state: { ...initialState, bots: [bot], groups: [group] },
      dispatch: vi.fn(),
      flushBotPatches: async () => null,
      refreshInstances: async () => {},
      refreshModels: async () => {},
    };
    flushSync(() => root.render(createElement(BotEditorStore, { value, children: overlay })));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    endCall(targetId);
    container.remove();
    delete window.ogb;
  });

  it("dismisses only the Dictation warning, leaving the call and its retry in place", () => {
    const failure = { code: 1, reason: "dictation-disabled" };
    const warning = t("composer.dictation.disabled");
    expect(speechStart).toHaveBeenCalledOnce();
    fail(failure);
    expect(container.textContent).toContain(warning);
    const retryButton = retry();
    const dismissButton = dismiss();
    expect(retryButton).toBeDefined();
    expect(dismissButton).not.toBeNull();
    dismissButton!.focus();
    expect(document.activeElement).toBe(dismissButton);
    flushSync(() => dismissButton!.click());

    expect(container.textContent).not.toContain(warning);
    expect(dismiss()).toBeNull();
    expect(retry()).toBe(retryButton);
    expect(document.activeElement).toBe(retryButton);
    expect(currentCall()).toBe(targetId);
    expect(speechStart).toHaveBeenCalledOnce();
    expect(speechStop).not.toHaveBeenCalled();

    flushSync(() => retryButton!.click());
    expect(speechStart).toHaveBeenCalledTimes(2);
    expect(retry()).toBeUndefined();
    fail(failure);
    expect(container.textContent).toContain(warning);
    expect(dismiss()).not.toBeNull();
    expect(retry()).toBeDefined();
  });

  it("keeps bridge-supplied text for a dismissible Dictation warning", () => {
    const message = "Open Dictation in System Settings.";
    fail({ code: 1, reason: "dictation-disabled", message });
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain(t("composer.dictation.disabled"));
    expect(dismiss()).not.toBeNull();
  });

  it.each([
    { info: { code: 2, reason: "dictation-disabled" }, message: t("call.turns.needsDictation") },
    { info: { code: 1, reason: "helper-build-failed" }, message: t("call.turns.helperBuildFailed") },
    { info: { code: 1, reason: "speech-not-authorized" }, message: t("call.turns.speechNotAuthorized") },
    { info: { code: 1, reason: "recognition-error", message: t("composer.dictation.disabled") }, message: t("composer.dictation.disabled") },
  ])("preserves the warning for $info.reason (code $info.code)", ({ info, message }) => {
    fail(info);
    expect(container.textContent).toContain(message);
    expect(dismiss()).toBeNull();
    expect(retry()).toBeDefined();
  });
});
