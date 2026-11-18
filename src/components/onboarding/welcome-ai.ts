import { useCallback, useEffect, useRef, useState } from "react";
import { aiSignInKey, type AiTestState } from "../../../shared/ai-ranking";
import { engineReady } from "@/components/EngineLibrary";
import type { ConnectAiPlace } from "@/lib/analytics-allowlist";
import { connectAiStep } from "@/lib/connect-ai-events";
import { welcomeAi } from "@/lib/onboarding";
import { api, type InstanceInfo } from "@/state/store";

type Answer = { ok?: boolean | null; error?: string; reason?: string } | undefined;
type Known = { state: AiTestState; error?: string; reason?: string };

const keyOf = (instance: InstanceInfo) => `${instance.instanceId}\n${aiSignInKey(instance.snapshot)}`;
/** As the new-bot default sees it: an AI that offers no model yet (OpenCode still listing them) can't run a bot. */
export const aiRuns = (instance: InstanceInfo) =>
  engineReady(instance) && Boolean(instance.models.default.trim() || instance.models.options.some((option) => option.id.trim()));

export type WelcomeAiNow = NonNullable<ReturnType<typeof welcomeAi<InstanceInfo>>> & {
  /** The plain reason its test failed, when it gave one (signed out, a used-up limit…). */
  error?: string;
  /** The same failure as a word from a fixed list, for usage analytics. */
  reason?: string;
  /** Check again: one more test message. */
  retry(): void;
};

/** The AI the welcome stands on (welcomeAi), after one tiny test message through the server's check when this sign-in
 * hasn't had one: the server shares a test already under way, and its result also settles the new-bot default. A check
 * that can't be made trusts the AI as before. `enabled` is false for a viewer who can't run checks; `chosen` is the AI the
 * person picked on the welcome, which counts even as OpenCode's free backup; `place` names the first-run flow for usage
 * analytics. */
export function useWelcomeAi(instances: readonly InstanceInfo[], enabled = true, chosen: string | null = null,
  place: ConnectAiPlace | null = null): WelcomeAiNow | null {
  const [answers, setAnswers] = useState<Record<string, Known>>({});
  const asked = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const ask = useCallback((key: string, driverKind: string) => {
    if (asked.current.has(key)) return;
    asked.current.add(key);
    const instanceId = key.slice(0, key.indexOf("\n"));
    const started = Date.now();
    if (place) connectAiStep("test_started", place, { driverKind });
    void api<Answer>(`/api/instances/${encodeURIComponent(instanceId)}/check`, { method: "POST", body: "{}", timeoutMs: 120_000 })
      .then((answer): Known => answer?.ok === true ? { state: "passed" } : answer?.ok === false
        ? { state: "failed", ...(answer.error ? { error: answer.error } : {}), reason: answer.reason ?? "other" } : { state: "untestable" },
      (): Known => ({ state: "untestable" }))
      .then((known) => {
        if (place && known.state !== "untestable") {
          connectAiStep(known.state === "passed" ? "test_ok" : "test_failed", place, { driverKind, seconds: (Date.now() - started) / 1000, reason: known.reason });
        }
        asked.current.delete(key);
        if (live.current) setAnswers((current) => ({ ...current, [key]: known }));
      });
  }, [place]);
  const known = (instance: InstanceInfo): Known | undefined => answers[keyOf(instance)]
    ?? (instance.aiTest && instance.aiTest !== "testing" ? { state: instance.aiTest, ...(instance.aiTestError ? { error: instance.aiTestError } : {}), ...(instance.aiTestReason ? { reason: instance.aiTestReason } : {}) }
      : undefined);
  const found = welcomeAi(instances, aiRuns, (instance) => known(instance)?.state, (instance) => instance.instanceId === chosen);
  const asking = enabled && found?.state === "testing" ? keyOf(found.instance) : null;
  const askingKind = found?.instance.driverKind ?? "";
  useEffect(() => {
    if (asking) ask(asking, askingKind);
  }, [asking, askingKind, ask]);
  if (!found) return null;
  const key = keyOf(found.instance);
  const failure = found.state === "failed" ? known(found.instance) : undefined;
  return {
    ...found,
    ...(failure?.error ? { error: failure.error } : {}),
    ...(failure?.reason ? { reason: failure.reason } : {}),
    retry: () => {
      if (!enabled) return;
      setAnswers((current) => ({ ...current, [key]: { state: "testing" } }));
      ask(key, found.instance.driverKind);
    },
  };
}
