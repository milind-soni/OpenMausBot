import { useEffect, useRef } from "react";
import { useLanguageChoice } from "@/lib/language-preference";
import { duePing, openTarget, presenceBody, shownLanguage } from "@/lib/presence-client";
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
  const language = shownLanguage(state.config?.language, useLanguageChoice());
  const latest = useRef({ state, dispatch, showThreads, language });
  latest.current = { state, dispatch, showThreads, language };
  const sentLanguage = useRef(language);
  const pingNow = useRef<() => void>(() => {});
  useEffect(() => {
    if (!state.hydrated) return;
    const ping = (force = false) => {
      const now = Date.now();
      if (!force && !duePing(lastPing.current, now)) return;
      lastPing.current = now;
      const sentFrom = selection(latest.current.state);
      sentLanguage.current = latest.current.language;
      void api("/api/presence/active", { method: "POST", body: JSON.stringify(presenceBody(Intl.DateTimeFormat().resolvedOptions().timeZone, sentLanguage.current)) }).then((answer) => {
        const live = latest.current;
        const target = existingThreadTarget(openTarget(answer), live.state);
        if (target && selection(live.state) === sentFrom) openThread(live.dispatch, target, live.state, live.showThreads);
      }, () => {});
    };
    const onActivity = () => ping();
    const onVisible = () => { if (document.visibilityState === "visible") ping(); };
    pingNow.current = () => ping(true);
    onVisible();
    for (const name of ACTIVITY) window.addEventListener(name, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      pingNow.current = () => {};
      for (const name of ACTIVITY) window.removeEventListener(name, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.hydrated]);
  useEffect(() => {
    if (language !== sentLanguage.current) pingNow.current();
  }, [language]);
}
