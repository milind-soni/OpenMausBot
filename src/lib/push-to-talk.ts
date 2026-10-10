import { useEffect, useRef, useState } from "react";

import { currentCall } from "./call";
import { speechBridge } from "./stt/bridge";

type ModifierEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "code" | "repeat">;

export function isPushToTalkPress(event: ModifierEvent): boolean {
  const modifier =
    event.code === "AltLeft" ||
    event.code === "AltRight" ||
    event.code === "ControlLeft" ||
    event.code === "ControlRight";
  return modifier && event.altKey && event.ctrlKey && !event.repeat;
}

/** Hold Control + Option to replace automatic endpointing with a manually
 * finalized utterance. The ordinary call listener remains the default. */
export function usePushToTalk(targetId: string, enabled: boolean, onError: () => void): boolean {
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
    const bridge = speechBridge();
    // Older macOS shells lack speechFinish; push-to-talk needs it.
    if (!bridge || (bridge.kind === "native" && !window.ogb?.speechFinish)) return;

    const finish = () => {
      if (!held.current) return;
      held.current = false;
      setActive(false);
      void bridge.finish();
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
      void bridge.start().catch(() => {
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
  }, [targetId]);

  return active;
}
