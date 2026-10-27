import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { engineReady } from "@/components/EngineLibrary";
import { t } from "@/lib/i18n";
import { api, type InstanceInfo } from "@/state/store";

export type EngineLiveCheck = { state: "checking" } | { state: "working" } | { state: "failed"; error: string };
type Answer = { ok: true } | { ok: false; error: string } | { ok: null };

/** Right after one of these engines is connected here, one tiny real message checks that it answers. An engine already
 * connected when this first renders is left alone. */
export function useEngineLiveCheck(engines: readonly InstanceInfo[]) {
  const [checks, setChecks] = useState<Record<string, EngineLiveCheck>>({});
  const seen = useRef<Map<string, boolean> | null>(null);
  const run = useCallback(async (instanceId: string) => {
    setChecks((current) => ({ ...current, [instanceId]: { state: "checking" } }));
    let next: EngineLiveCheck | null;
    try {
      const answer = await api<Answer>(`/api/instances/${encodeURIComponent(instanceId)}/check`, { method: "POST", body: "{}", timeoutMs: 120_000 });
      next = answer.ok === true ? { state: "working" } : answer.ok === false ? { state: "failed", error: answer.error } : null;
    } catch (error) {
      next = { state: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    setChecks(({ [instanceId]: _done, ...rest }) => next ? { ...rest, [instanceId]: next } : rest);
  }, []);
  useEffect(() => {
    const now = new Map(engines.map((engine) => [engine.instanceId, engineReady(engine)]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    for (const [instanceId, ready] of now) if (ready && before.get(instanceId) === false) void run(instanceId);
  }, [engines, run]);
  return { checks, run };
}

export function EngineCheckLine({ name, check, onRetry }: { name: string; check: EngineLiveCheck; onRetry: () => void }) {
  if (check.state === "checking") return <p role="status" data-engine-check="checking" className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
    <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" />{t("engineCheck.checking", { name })}
  </p>;
  if (check.state === "working") return <p role="status" data-engine-check="working" className="mt-3 flex items-center gap-2 text-[13px] font-medium text-success">
    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />{t("engineCheck.working", { name })}
  </p>;
  return <div role="alert" data-engine-check="failed" className="mt-3 rounded-xl bg-warning/10 px-3.5 py-3 text-[13px] leading-relaxed text-ink">
    <p className="flex items-start gap-2">
      <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <span><span className="font-medium">{t("engineCheck.failed", { name })}</span> {check.error}</span>
    </p>
    <button type="button" onClick={onRetry} className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-ink transition-colors hover:bg-raised">
      <RefreshCw size={12} aria-hidden="true" />{t("engineCheck.retry")}
    </button>
  </div>;
}
