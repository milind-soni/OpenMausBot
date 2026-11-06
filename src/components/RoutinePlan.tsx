import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { RoutineStepStatus } from "../../shared/routines";
import { BotAvatar } from "./Avatar";

const STATE_WORD: Partial<Record<RoutineStepStatus, LocaleKey>> = {
  done: "automations.run.done",
  running: "automations.runningNow",
  skipped: "routines.plan.skipped",
  failed: "automations.run.failed",
};

/** A stepped routine's plan, read-only: who does each step, on which model, and how its newest run is getting on. */
export function RoutinePlan({ routineId }: { routineId: string }) {
  const { state } = useStore();
  const steps = state.routines.find((routine) => routine.id === routineId)?.steps;
  if (!steps?.length) return null;
  const run = state.routineRuns.filter((candidate) => candidate.routineId === routineId).sort((a, b) => b.createdAt - a.createdAt)[0];
  // An edit after the run was queued changes the list; its states no longer line up.
  const stepRuns = run?.plan?.length === steps.length ? run.stepRuns : undefined;

  return (
    <ol aria-label={t("routines.plan.label")} data-routine-plan={routineId} className="mt-2 list-decimal space-y-1.5 border-t border-hairline/45 pl-[44px] pt-2 text-[12px] text-ink-secondary marker:text-ink-tertiary">
      {steps.map((step, index) => {
        const bot = state.bots.find((candidate) => candidate.id === step.botId);
        const ran = stepRuns?.[index];
        const model = ran?.model ?? (step.model === "quick" ? t("routines.plan.quick") : undefined);
        const word = ran && STATE_WORD[ran.status];
        return (
          <li key={index} className="pl-1">
            <div className="flex items-center gap-1.5">
              {bot && <span aria-hidden="true" className="flex shrink-0"><BotAvatar bot={bot} state="happy" size={16} animated={false} motion="none" motionKey={0} label="" /></span>}
              <span className="min-w-0 truncate font-medium text-ink">{bot?.name ?? t("routines.unavailableBot")}</span>
              {model && <span className="shrink-0 text-ink-tertiary">· {model}</span>}
              {word && <span className="ml-auto shrink-0 text-ink-tertiary">{t(word)}</span>}
            </div>
            <p className="line-clamp-2 break-words">{step.check ? t("routines.plan.onlyIf", { question: step.instructions }) : step.instructions}</p>
          </li>
        );
      })}
    </ol>
  );
}
