// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("./call", () => ({ currentCall: () => "bot-1" }));

import { usePushToTalk } from "./push-to-talk";
import type { SpeechBridge } from "./recorded-speech";

it("records with the call's own bridge and destination while the keys are held", () => {
  const bridge = {
    speechStart: vi.fn(async () => {}), speechStop: vi.fn(async () => {}), speechFinish: vi.fn(async () => {}),
    onSpeechTranscript: () => () => {}, onSpeechEnd: () => () => {},
  } satisfies SpeechBridge;
  const Probe = () => { usePushToTalk("bot-1", true, () => {}, { bridge, destination: "openai http://localhost:8000/v1" }); return null; };
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(createElement(Probe)));
  flushSync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", ctrlKey: true, altKey: true })); });
  expect(bridge.speechStart).toHaveBeenCalledExactlyOnceWith({ destination: "openai http://localhost:8000/v1" });
  flushSync(() => { window.dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft" })); });
  expect(bridge.speechFinish).toHaveBeenCalledOnce();
  flushSync(() => root.unmount());
});
