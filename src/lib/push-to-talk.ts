import { useEffect, useRef, useState } from "react";

import { currentCall } from "./call";
import { isMacPlatform } from "./keyboard-shortcuts";
import type { SpeechBridge } from "./recorded-speech";

type ModifierEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "code" | "repeat">;

export const pushToTalkKeys = () => (isMacPlatform() ? "Control + Option" : "Ctrl + Alt");

export function isPushToTalkPress(event: ModifierEvent): boolean {
  const modifier =
    event.code === "AltLeft" ||
    event.code === "AltRight" ||
    event.code === "ControlLeft" ||
    event.code === "ControlRight";
  return modifier && event.altKey && event.ctrlKey && !event.repeat;
}

/** `bridge` and `destination` are the call's own, fixed when it opened, so a held key records where the call listens. */
export function usePushToTalk(
  targetId: string, enabled: boolean, onError: () => void, speech: { bridge: SpeechBridge | Window["ogb"]; destination: string },
): boolean {
  const { bridge, destination } = speech;
  const [active, setActive] = useState(false);
  const held = useRef(false);
  const enabledRef = useRef(enabled);
  const onErrorRef = useRef(onError);
  enabledRef.current = enabled;
  onErrorRef.current = onError;

  useEffect(() => {
    if (enabled) return;
    held.current = false;
    setActive(false);
  }, [enabled]);

  useEffect(() => {
    if (!bridge?.speechFinish) return;

    const finish = () => {
      if (!held.current) return;
      held.current = false;
      setActive(false);
      void bridge.speechFinish?.();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        held.current ||
        !enabledRef.current ||
        currentCall() !== targetId ||
        !isPushToTalkPress(event)
      ) {
        return;
      }
      event.preventDefault();
      held.current = true;
      setActive(true);
      void bridge.speechStart({ destination }).catch(() => {
        held.current = false;
        setActive(false);
        onErrorRef.current();
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!held.current || (event.altKey && event.ctrlKey)) return;
      event.preventDefault();
      finish();
    };
    const onBlur = () => finish();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      held.current = false;
    };
  }, [targetId, bridge, destination]);

  return active;
}
