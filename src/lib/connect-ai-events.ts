import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { track } from "@/lib/analytics";
import {
  AI_TEST_REASON, allow, CONNECT_AI_PLACE, CONNECT_AI_STEP, engineForDriver, type ConnectAiPlace, type ConnectAiStep,
} from "@/lib/analytics-allowlist";
import { useStore } from "@/state/store";

/** Which first-run flow a Connect an AI control sits in. Outside one (Settings, the engine library) it is null and nothing
 * is sent. */
export const ConnectAiPlaceContext = createContext<ConnectAiPlace | null>(null);
export const useConnectAiPlace = () => useContext(ConnectAiPlaceContext);

export type ConnectAiFacts = { driverKind?: string; reason?: unknown; seconds?: number; aiReady?: boolean };

export function connectAiStep(step: ConnectAiStep, place: ConnectAiPlace, facts: ConnectAiFacts = {}): void {
  track("connect_ai", {
    step: allow(step, CONNECT_AI_STEP),
    place: allow(place, CONNECT_AI_PLACE),
    ...(facts.driverKind !== undefined ? { engine: engineForDriver(facts.driverKind) } : {}),
    ...(step === "test_failed" || (step === "opened" && facts.reason !== undefined) ? { reason: allow(facts.reason, AI_TEST_REASON) } : {}),
    ...(typeof facts.seconds === "number" && Number.isFinite(facts.seconds) ? { seconds: Math.max(0, Math.round(facts.seconds)) } : {}),
    ...(typeof facts.aiReady === "boolean" ? { ai_ready: facts.aiReady } : {}),
  });
}

/** `connectAiStep` for one mounted control: `opened` once, every other step once for each engine (React's StrictMode
 * mounts twice in development). */
export function useConnectAiSteps(place: ConnectAiPlace | null) {
  const sent = useRef(new Set<string>());
  return useCallback((step: ConnectAiStep, facts: ConnectAiFacts = {}) => {
    const key = step === "opened" ? step : `${step}\n${facts.driverKind ?? ""}`;
    if (!place || sent.current.has(key)) return;
    sent.current.add(key);
    connectAiStep(step, place, facts);
  }, [place]);
}

/** The Connect an AI dialog's own step, once for each time it opens. */
export function useDialogOpened(place: ConnectAiPlace | null): void {
  const sent = useRef(false);
  useEffect(() => {
    if (!place || sent.current) return;
    sent.current = true;
    connectAiStep("dialog_opened", place);
  }, [place]);
}

/** A sign-in to an AI starting inside a first-run flow; elsewhere it sends nothing. */
export function useSignInStarted(instanceId: string) {
  const step = useConnectAiSteps(useConnectAiPlace());
  const instances = useStore().state?.instances;
  return () => step("sign_in_started", { driverKind: instances?.find((instance) => instance.instanceId === instanceId)?.driverKind ?? "" });
}
