import { useEffect, useState } from "react";
import { openChatLink } from "@/components/ThreadRefs";
import { useShowThreads } from "@/lib/thread-preferences";
import { takeThreadLinkFromLocation } from "@/lib/thread-refs";
import { openThread, type Action, type AppState, type ThreadTarget } from "@/state/store";

export function useExternalChatLinks(state: AppState, dispatch: (action: Action) => void): void {
  const [link, setLink] = useState<string | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => {
    const fromAddress = takeThreadLinkFromLocation();
    if (fromAddress) setLink(fromAddress);
    return window.ogb?.onChatLink?.(setLink);
  }, []);
  useEffect(() => {
    if (!link || !state.hydrated) return;
    setLink(null);
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });
    openChatLink(dispatch, link, state, showThreads);
  }, [link, state, showThreads, dispatch]);
}

/** A click on a notification main showed brought this page up, maybe a page just loaded for it. */
export function useDesktopNotificationOpens(state: AppState, dispatch: (action: Action) => void): void {
  const [target, setTarget] = useState<ThreadTarget | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => window.ogb?.desktopNotifications?.onOpen(setTarget), []);
  useEffect(() => {
    if (!target || !state.hydrated) return;
    setTarget(null);
    openThread(dispatch, target, state, showThreads);
  }, [target, state, showThreads, dispatch]);
}
