import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  applyTeamPlan,
  planNeedsLocalAutoConsent,
  planTeamChange,
  TEAM_APPROVAL_MODES,
  teamBots,
  teamEffortChoices,
  teamModelChoices,
  teamResultCounts,
  type TeamApprovalMode,
  type TeamChange,
  type TeamPlanRow,
  type TeamResultRow,
} from "@/lib/team-bulk-settings";
import { api, desktopApprovalBridge, persistBotUpdate, useStore } from "@/state/store";
import { EFFORT_LEVELS, type EffortLevel } from "../../shared/wire";
import { approvalModeOptions } from "./ApprovalModeSelector";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { effortLabel } from "./ModelPicker";
import { Select } from "./Select";

type Tab = "approval" | "model";
const KEEP = "";
const ENGINE_DEFAULT = "default";

export function TeamSettingsRows({ rows }: { rows: ReadonlyArray<TeamPlanRow | TeamResultRow> }) {
  return (
    <ul className="flex flex-col gap-1" data-testid="team-settings-rows">
      {rows.map((row) => {
        const [label, tone] = row.status === "apply" ? [t("teamSettings.row.willChange"), "text-accent"]
          : row.status === "applied" ? [t("teamSettings.row.applied"), "text-success"]
            : row.status === "unchanged" ? [t("teamSettings.row.unchanged"), "text-ink-secondary"]
              : [t("teamSettings.row.skipped", { reason: row.reason }), "text-warning"];
        return (
          <li key={row.bot.id} className="flex items-start justify-between gap-3 rounded-lg bg-inset px-3 py-1.5 text-[13px]">
            <span className="min-w-0 truncate text-ink">{row.bot.name}</span>
            <span className={cn("max-w-[65%] text-right text-[12px]", tone)}>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function TeamSettingsDialog({ team, onClose }: { team: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [tab, setTab] = useState<Tab>("approval");
  const [mode, setMode] = useState<TeamApprovalMode | null>(null);
  const [model, setModel] = useState<string>(KEEP);
  const [effort, setEffort] = useState<string>(KEEP);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<TeamResultRow[] | null>(null);
  const [consent, setConsent] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  const bots = useMemo(() => teamBots(state.bots, team), [state.bots, team]);
  const models = useMemo(() => teamModelChoices(bots, state.instances), [bots, state.instances]);
  const efforts = useMemo(() => teamEffortChoices(bots, state.instances, EFFORT_LEVELS), [bots, state.instances]);
  const change: TeamChange | null = tab === "approval"
    ? mode ? { kind: "approval", mode } : null
    : model === KEEP && effort === KEEP ? null
      : {
        kind: "model",
        ...(model === KEEP ? {} : { model }),
        ...(effort === KEEP ? {} : { effort: effort === ENGINE_DEFAULT ? null : effort as EffortLevel }),
      };
  const plan = change ? planTeamChange(bots, state.instances, change) : [];
  const applying = plan.filter((row) => row.status === "apply").length;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const run = async (acknowledgeLocalAuto: boolean) => {
    if (running || !applying) return;
    setRunning(true);
    setProgress(0);
    const outcome = await applyTeamPlan(plan, async (bot, patch) => {
      const saved = await persistBotUpdate(bot.id, patch, new AbortController().signal, api, desktopApprovalBridge(), bot);
      dispatch({ type: "botPatched", bot: saved });
    }, { acknowledgeLocalAuto, onProgress: setProgress });
    setResults(outcome);
    setRunning(false);
  };
  const apply = () => {
    if (planNeedsLocalAutoConsent(plan)) setConsent(true);
    else void run(false);
  };
  const close = () => { if (!running) onClose(); };
  const counts = results ? teamResultCounts(results) : null;
  const tabClass = (active: boolean) => cn("flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium",
    active ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink");

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="team-settings-title" data-testid="team-settings-dialog"
        className="max-h-[90vh] w-full max-w-[460px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl"
        onKeyDown={(event) => { if (event.key === "Escape" && !consent) { event.stopPropagation(); close(); } }}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 id="team-settings-title" className="text-[17px] font-semibold">{t("teamSettings.title", { name: team || t("teamSettings.general") })}</h2>
          <button type="button" aria-label={t("teamSettings.close")} disabled={running} onClick={close} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </div>
        {results && counts ? (
          <>
            <p role="status" className="mb-3 text-[13px] text-ink-secondary">
              {t("teamSettings.summary", { applied: counts.applied, unchanged: counts.unchanged, skipped: counts.skipped })}
            </p>
            <TeamSettingsRows rows={results} />
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white">{t("teamSettings.done")}</button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-[13px] leading-relaxed text-ink-secondary">{t("teamSettings.intro", { count: bots.length })}</p>
            <div className="mb-3 flex gap-1 rounded-lg bg-inset p-0.5" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "approval"} disabled={running} className={tabClass(tab === "approval")} onClick={() => setTab("approval")}>{t("teamSettings.tab.approval")}</button>
              <button type="button" role="tab" aria-selected={tab === "model"} disabled={running} className={tabClass(tab === "model")} onClick={() => setTab("model")}>{t("teamSettings.tab.model")}</button>
            </div>
            {tab === "approval" ? (
              <fieldset disabled={running} className="flex flex-col gap-1">
                <legend className="sr-only">{t("teamSettings.tab.approval")}</legend>
                {approvalModeOptions().filter((option) => (TEAM_APPROVAL_MODES as readonly string[]).includes(option.mode)).map((option) => (
                  <label key={option.mode} className={cn("flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2", mode === option.mode ? "bg-raised" : "hover:bg-raised/60")}>
                    <input type="radio" name="team-approval" className="mt-1" checked={mode === option.mode}
                      onChange={() => setMode(option.mode as TeamApprovalMode)} />
                    <span>
                      <span className="block text-[14px] text-ink">{option.label}</span>
                      <span className="block text-[12px] text-ink-secondary">{option.description}</span>
                    </span>
                  </label>
                ))}
                <p className="mt-1 text-[12px] text-ink-secondary">{t("teamSettings.allThreads")} {t("teamSettings.customPerBot")}</p>
              </fieldset>
            ) : (
              <fieldset disabled={running} className="flex flex-col gap-3">
                <label className="text-[13px] text-ink-secondary">{t("teamSettings.model")}
                  <Select className="mt-1 w-full" aria-label={t("teamSettings.model")} value={model} onChange={(event) => setModel(event.target.value)}>
                    <option value={KEEP}>{t("teamSettings.keepModel")}</option>
                    {models.map((choice) => <option key={choice.id} value={choice.id}>{`${choice.label} · ${choice.engines.join(", ")}`}</option>)}
                  </Select>
                </label>
                <label className="text-[13px] text-ink-secondary">{t("teamSettings.effort")}
                  <Select className="mt-1 w-full" aria-label={t("teamSettings.effort")} value={effort} onChange={(event) => setEffort(event.target.value)}>
                    <option value={KEEP}>{t("teamSettings.keepEffort")}</option>
                    <option value={ENGINE_DEFAULT}>{t("teamSettings.engineDefaultEffort")}</option>
                    {efforts.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
                  </Select>
                </label>
                <p className="text-[12px] text-ink-secondary">{t("teamSettings.threadModels")}</p>
              </fieldset>
            )}
            {change && (
              <div className="mt-4">
                <div className="mb-1 text-[12px] font-medium text-ink-secondary">{t("teamSettings.preview")}</div>
                <TeamSettingsRows rows={plan} />
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              {running && <span role="status" className="mr-auto text-[12px] text-ink-secondary">{t("teamSettings.progress", { done: progress, count: plan.length })}</span>}
              <button type="button" disabled={running} onClick={close} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">{t("common.cancel")}</button>
              <button type="button" disabled={running || !applying} onClick={apply}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40">
                {t(applying === 1 ? "teamSettings.applyOne" : "teamSettings.applyMany", { count: applying })}
              </button>
            </div>
          </>
        )}
      </div>
      <LocalComputerAutoWarning
        open={consent}
        onCancel={() => setConsent(false)}
        onConfirm={() => { setConsent(false); void run(true); }}
      />
    </div>, document.body,
  );
}
