import { useEffect, useRef } from "react";
import { duePing, openTarget, presenceBody } from "@/lib/presence-client";
import { useShowThreads } from "@/lib/thread-preferences";
import { existingThreadTarget } from "@/lib/thread-target";
import { openThread } from "@/state/thread-navigation";
import { api, type Action, type AppState } from "@/state/store";

const ACTIVITY = ["focus", "pointerdown", "keydown"] as const;

function selection(state: AppState): string {
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  const threadId = bot ? bot.switchingTo ?? bot.threadId : state.groups.find((group) => group.id === state.selectedId)?.threadId;
  return `${state.selectedId}\n${threadId ?? ""}`;
}

/** Tells the server the person is here, and opens the chat the answer names: the brief the Chief posted for this arrival. */
export function usePresence(state: AppState, dispatch: (action: Action) => void): void {
  const showThreads = useShowThreads();
  const lastPing = useRef<number | null>(null);
  const latest = useRef({ state, dispatch, showThreads });
  latest.current = { state, dispatch, showThreads };
  useEffect(() => {
    if (!state.hydrated) return;
    const ping = () => {
      const now = Date.now();
      if (!duePing(lastPing.current, now)) return;
      lastPing.current = now;
      const sentFrom = selection(latest.current.state);
      void api("/api/presence/active", { method: "POST", body: JSON.stringify(presenceBody()) }).then((answer) => {
        const live = latest.current;
        const target = existingThreadTarget(openTarget(answer), live.state);
        if (target && selection(live.state) === sentFrom) openThread(live.dispatch, target, live.state, live.showThreads);
      }, () => {});
    };
    const onVisible = () => { if (document.visibilityState === "visible") ping(); };
    onVisible();
    for (const name of ACTIVITY) window.addEventListener(name, ping, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      for (const name of ACTIVITY) window.removeEventListener(name, ping);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.hydrated]);
}
