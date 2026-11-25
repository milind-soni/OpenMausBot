import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics";
import { allow, APP_LOAD_WAITING } from "@/lib/analytics-allowlist";
import { LIVE_PHASES, livePhase } from "@/lib/live-events";
import { useStore } from "@/state/store";

export const SLOW_LOAD_MS = 30_000;

type LoadState = { connected: boolean; hydrated?: true; config: unknown };

export function loadWaitingFor(state: LoadState): (typeof APP_LOAD_WAITING)[number] | null {
  if (!state.connected) return "server";
  if (state.hydrated !== true) return "data";
  return state.config === null || state.config === undefined ? "settings" : null;
}

const sincePageStart = () => Math.round(performance.now() / 100) / 10;

/** Once per page: when the app has its server, its data and its settings (`ready`), or that it still waits for one of
 * them SLOW_LOAD_MS after the page started (`slow`), with what its live connection is doing then (`phase`). */
export function useAppLoadSignal(): void {
  const { state } = useStore();
  const waiting = loadWaitingFor(state);
  const sent = useRef<{ ready?: true; slow?: true }>({});
  const onboarded = Boolean(state.config?.onboarding?.completedAt);
  useEffect(() => {
    if (waiting !== null || sent.current.ready) return;
    sent.current.ready = true;
    track("app_load", { stage: "ready", seconds: sincePageStart(), onboarded });
  }, [waiting, onboarded]);
  useEffect(() => {
    if (waiting === null || sent.current.ready || sent.current.slow) return;
    const timer = setTimeout(() => {
      if (sent.current.ready || sent.current.slow) return;
      sent.current.slow = true;
      track("app_load", { stage: "slow", waiting: allow(waiting, APP_LOAD_WAITING), phase: allow(livePhase(), LIVE_PHASES) });
    }, Math.max(0, SLOW_LOAD_MS - performance.now()));
    return () => clearTimeout(timer);
  }, [waiting]);
}
