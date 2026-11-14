import { useEffect } from "react";
import { useOnCall } from "./call";
import { isLiveCallRunning, useLiveMedia, type LiveMediaPhase } from "./live-call-media";

export function callInProgress(onCall: string | null, phase: LiveMediaPhase): boolean {
  return onCall !== null || isLiveCallRunning(phase);
}

export function useReportCallPresence(): void {
  const onCall = useOnCall();
  const { phase } = useLiveMedia();
  const active = callInProgress(onCall, phase);
  useEffect(() => {
    void window.ogb?.callActive?.(active);
  }, [active]);
}
