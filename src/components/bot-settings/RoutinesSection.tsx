import { OverlayPresence } from "@/components/ModalPresence";
import { CalendarClock, ChevronRight, FileText, Plus } from "lucide-react";
import { useState } from "react";
import { useStore, type Bot } from "@/state/store";
import type { Routine, RoutineRun, RoutineRunOn } from "@/lib/routines";
import { t } from "@/lib/i18n";
import { RoutineEditor } from "../RoutinesPage";
import { RoutineList } from "../routines/RoutineList";

export function RoutinesSection({ bot, routines, runs, defaultRunOn }: { bot: Bot; routines: Routine[]; runs: RoutineRun[]; defaultRunOn?: RoutineRunOn }) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  return <div className="flex flex-col gap-4">
    <div className="rounded-2xl border border-hairline/50 bg-card p-3">
      <div className="flex items-center gap-2"><CalendarClock size={16} className="text-accent" /><h2 className="min-w-0 flex-1 text-[15px] font-medium text-ink">{t("computer.tab.routines")}</h2><span className="text-[12px] text-ink-secondary">{routines.length}</span></div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => setEditing("new")} className="ui-button ui-button-pill"><Plus size={14} />{t("computer.routines.create")}</button>
        <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", botId: bot.id })} className="ui-button ui-button-pill"><FileText size={13} />{t("routines.logs")}</button>
      </div>
    </div>
    <RoutineList routines={routines} runs={runs} pausedBots={state.config?.pausedBots} heldBots={state.config?.heldBots} loading={state.routinesLoadState === "loading" && routines.length === 0} error={state.routinesLoadState === "error"} unreadable={state.config?.routinesUnreadable} onOpen={setEditing} onLogs={(routine) => dispatch({ type: "showRoutines", section: "logs", botId: bot.id, routineId: routine.id })} onToggle={(routine) => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: !routine.enabled } })} />
    <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "schedule", view: "list", botId: bot.id })} className="self-start text-[12px] text-accent hover:underline">{t("computer.routines.openTitle")} <ChevronRight size={14} aria-hidden="true" className="inline align-[-2px] rtl:-scale-x-100" /></button>
    <OverlayPresence>{editing && <RoutineEditor key={bot.id} routine={editing === "new" ? undefined : editing} bots={[bot]} lockedBotId={bot.id} defaultRunOn={defaultRunOn} onClose={() => setEditing(null)} />}</OverlayPresence>
  </div>;
}
