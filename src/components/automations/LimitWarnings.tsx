import { useState } from "react";
import { Hourglass } from "lucide-react";

import { t } from "@/lib/i18n";
import { dueBeforeReset, limitLine, nearLimitEngines, useEngineLimits, type EngineLimit } from "@/lib/limit-resets";
import type { Routine } from "@/lib/routines";
import { api, useStore } from "@/state/store";

/** Each engine near its limit, with the automations due before it resets and one button that moves just their next
 * run to after the reset. */
export function LimitWarnings({ botFilter = "all" }: { botFilter?: string }) {
  const { state, dispatch } = useStore();
  const engines = nearLimitEngines(useEngineLimits());
  const [busy, setBusy] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!engines.length) return null;
  const botEngine = (botId: string) => state.bots.find((bot) => bot.id === botId)?.modelSelection?.instanceId;
  const routines = state.routines.filter((routine) => botFilter === "all" || routine.botId === botFilter);
  const move = async (limit: EngineLimit, due: Routine[]) => {
    setBusy(limit.engine);
    setError("");
    try {
      for (const routine of due) {
        const response = await api<{ routine: Routine }>("/api/limit-resets/after-reset", { method: "POST", body: JSON.stringify({ routineId: routine.id, engine: limit.engine }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      }
      setMoved(limit.engine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label={t("limits.title")} className="mb-4 space-y-2">
      {engines.map((limit) => {
        const due = dueBeforeReset(routines, botEngine, limit);
        return (
          <div key={limit.engine} data-limit-warning={limit.engine} role="status"
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-[13px] text-ink">
            <Hourglass size={15} className="shrink-0 text-warning" aria-hidden="true" />
            <span className="font-medium tabular-nums">{limitLine(limit)}</span>
            {due.length > 0 ? (
              <>
                <span className="text-ink-secondary">{t(due.length === 1 ? "limits.dueOne" : "limits.dueMany", { count: due.length })}</span>
                <button type="button" disabled={busy === limit.engine} onClick={() => void move(limit, due)}
                  className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50">
                  {t("limits.moveAfterReset")}
                </button>
              </>
            ) : moved === limit.engine && <span className="text-ink-secondary">{t("limits.moved")}</span>}
          </div>
        );
      })}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </section>
  );
}
