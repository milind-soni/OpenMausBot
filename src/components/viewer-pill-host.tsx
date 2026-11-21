import { useCallback, useEffect, useRef, useState } from "react";

import { signInWaits } from "../../shared/sign-in-request";
import type { ComputerHelpRef } from "../../shared/wire";
import { viewerPillState } from "@/lib/handoff";
import { answerSignIn } from "@/lib/sign-in";
import type { Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { ViewerPill } from "./ViewerPill";

/** The request a bot's place waits on, when it is this one: the card whose Take over opened the viewer while it still
 * waits, else the newest request for the browser, or for its computer. */
export function useWaitingHelp(botId: string, browser: boolean): ComputerHelpRef | null {
  const help = useStoreSelector((state) => state.computerControl?.[botId]?.help ?? null);
  const opened = useStoreSelector((state) => {
    const focus = state.signInFocus;
    if (!focus?.threadId || focus.botId !== botId || (focus.place === "browser") !== browser) return null;
    const card = state.bots.find((bot) => bot.id === botId)?.messages.find((row) => row.id === focus.messageId)?.signIn;
    return card && card.stopped !== true && signInWaits(card) ? { botId, threadId: focus.threadId, messageId: focus.messageId, site: focus.site, place: focus.place } : null;
  }, (a, b) => a?.messageId === b?.messageId && a?.threadId === b?.threadId);
  if (opened) return opened;
  return help && (help.place === "browser") === browser ? help : null;
}

/** I'm done answers the request and folds the viewer back into the chat; a failed answer keeps both as they were. */
function useDone(help: ComputerHelpRef | null, onCollapse: () => void) {
  const [busy, setBusy] = useState(false);
  const done = () => {
    if (!help || busy) return;
    setBusy(true);
    answerSignIn(help, "done").then(onCollapse, () => undefined).finally(() => setBusy(false));
  };
  return { busy, done };
}

/**
 * The person's hold on the tab the desktop app's native pane shows: while held, the bot may only read it. Taken and
 * handed back through the app, which names the tab; a hold this view took goes back when the view goes.
 */
export function usePaneHold(botId: string, threadId: string | null, enabled: boolean, requestOpen = false) {
  const [held, setHeld] = useState(false);
  const mine = useRef(false);
  const wasOpen = useRef(requestOpen);
  const set = useCallback((want: boolean) => {
    const bridge = window.ogb?.browserPane;
    if (!enabled || !bridge?.hold) return;
    void bridge.hold({ botId, threadId, held: want }).then((answer) => { mine.current = answer.held; setHeld(answer.held); }, () => { mine.current = false; setHeld(false); });
  }, [botId, threadId, enabled]);
  useEffect(() => () => {
    if (mine.current) void window.ogb?.browserPane?.hold?.({ botId, threadId, held: false }).catch(() => undefined);
    mine.current = false;
  }, [botId, threadId]);
  // However the request ended (on the card, Skip, expiry, an answer in the chat, Connect), the bot gets its tab back.
  useEffect(() => {
    if (wasOpen.current && !requestOpen && mine.current) set(false);
    wasOpen.current = requestOpen;
  }, [requestOpen, set]);
  return { held: enabled && held, set };
}

/** Under a full-size browser: the one pill, centred. It sits below the page rather than over it, since the desktop app's
 * native pane draws above anything laid over the page; the browser's own Restore folds the viewer. */
export function BrowserViewerPill({ bot, you, pending, onTake, onStop, onCollapse, onDone }: {
  bot: Pick<Bot, "id">;
  /** This person drives the browser now. */
  you: boolean;
  /** Their take is on its way. */
  pending: boolean;
  onTake: () => void;
  onStop: () => void;
  onCollapse: () => void;
  /** After I'm done answered the request, before the viewer folds. */
  onDone?: () => void;
}) {
  const help = useWaitingHelp(bot.id, true);
  const { busy, done } = useDone(help, () => { onDone?.(); onCollapse(); });
  return (
    <div data-viewer-pill-row="" className="relative flex shrink-0 items-center justify-center border-t border-hairline/30 px-4 py-2.5">
      <ViewerPill state={viewerPillState({ inControl: you, requestPending: help !== null })} busy={busy || pending} onTake={onTake} onStop={onStop} onDone={done} />
    </div>
  );
}

export function DesktopViewerPill({ botId, inControl, busy: changing, onTake, onStop, onCollapse }: {
  botId: string;
  inControl: boolean;
  busy: boolean;
  onTake: () => void;
  onStop: () => void;
  onCollapse: () => void;
}) {
  const help = useWaitingHelp(botId, false);
  const { busy, done } = useDone(help, onCollapse);
  return (
    <div className="pointer-events-none flex shrink-0 justify-center px-4 py-3">
      <ViewerPill state={viewerPillState({ inControl, requestPending: help !== null })} busy={busy || changing} onTake={onTake} onStop={onStop} onDone={done} />
    </div>
  );
}
