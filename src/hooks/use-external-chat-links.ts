import { useEffect, useState } from "react";
import { openChatLink } from "@/components/ThreadRefs";
import { stepAsideWelcome } from "@/lib/cloud-welcome";
import { oneWorkspaceBridge } from "@/lib/one-workspace";
import { useShowThreads } from "@/lib/thread-preferences";
import type { Action, AppState } from "@/state/store";

export function useExternalChatLinks(state: AppState, dispatch: (action: Action) => void): void {
  const [link, setLink] = useState<string | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => window.ogb?.onChatLink?.(setLink), []);
  useEffect(() => {
    const bridge = oneWorkspaceBridge();
    if (!bridge) return;
    let live = true;
    // The person opened this bot from the other side: its chat, not My Cloud's welcome, which waits in Set up My Cloud.
    void bridge.take().then((taken) => { if (live && taken) { stepAsideWelcome(); setLink(taken); } }, () => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!link || !state.hydrated) return;
    setLink(null);
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });
    openChatLink(dispatch, link, state, showThreads);
  }, [link, state, showThreads, dispatch]);
}
