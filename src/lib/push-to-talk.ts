// The call's talk key: the bare SPACE BAR.
//
// One gesture carries all three things a voice call needs, which is why it is
// the space bar rather than a chord:
//
//   not held   the agent runs the call — its own endpointer decides when the
//              user's turn ended, exactly as before;
//   press      "I am talking now". The ear opens, and if the agent is mid
//              sentence this IS the interruption: its audio stops in the same
//              tick, because talking over an agent that keeps talking is not
//              a conversation;
//   release    the turn is over — the utterance is finalized and sent, so the
//              agent answers what was just said.
//
// While the key is down the automatic endpointer stands aside (see
// OfflineCallStt.holdTurn): a breath in the middle of a sentence is not the
// end of a turn, and the user is already telling us where the turn ends.
//
// Space is a heavily shared key, so two things are deliberately excluded: a
// text field keeps its space bar (typing is never talking), and any modifier
// turns the gesture into somebody else's shortcut.
import { useEffect, useRef, useState } from "react";

type TalkKeyEvent = Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat">;

/** Space alone, not an auto-repeat, no modifiers. */
export function isTalkKey(event: TalkKeyEvent): boolean {
  return (
    event.code === "Space" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat
  );
}

/** A field the user is typing in owns its own space bar. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return element.isContentEditable === true;
}

export interface CallTalkHandlers {
  /** True while this call is the live one in this window. */
  isCallLive: () => boolean;
  /** Space went down: open the ear and, if the agent is speaking, cut it off. */
  onTalkStart: () => void;
  /** Space came up: finalize the turn so the agent can answer. */
  onTalkEnd: () => void;
}

/** True while the talk key is held, for the on-screen indicator. */
export function useCallTalk(handlers: CallTalkHandlers): boolean {
  const [talking, setTalking] = useState(false);
  const callbacks = useRef(handlers);
  callbacks.current = handlers;

  useEffect(() => {
    let down = false;

    const end = () => {
      if (!down) return;
      down = false;
      setTalking(false);
      callbacks.current.onTalkEnd();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (down || !isTalkKey(event) || isTypingTarget(event.target)) return;
      if (!callbacks.current.isCallLive()) return;
      // The page must not scroll under the call, and a focused button must not
      // also activate: the space bar belongs to the conversation here.
      event.preventDefault();
      down = true;
      setTalking(true);
      callbacks.current.onTalkStart();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!down || event.code !== "Space") return;
      event.preventDefault();
      end();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // A focus steal mid-hold means the keyup never arrives in this window:
    // finalize what was said rather than leaving the microphone pinned open.
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", end);
      down = false;
    };
  }, []);

  return talking;
}