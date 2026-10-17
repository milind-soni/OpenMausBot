import { useState } from "react";
import { ChevronRight, FileText, Plus, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { BotOverview } from "@/lib/bot-overview-types";
import { friendlyEffort, simpleEffortLevels } from "@/lib/model-friendly";
import type { Routine } from "@/lib/routines";
import { routineFinished, routineNextLabel } from "@/lib/routine-display";
import { scheduleLabel } from "@/lib/schedule-label";
import { firstSentence } from "@/lib/soul";
import { currentTaskBot, useStore, type Bot } from "@/state/store";
import type { ApprovalMode } from "../../../shared/approval-mode";
import type { EffortLevel } from "../../../shared/wire";
import type { ReplyStyle } from "../../../shared/reply-style";
import { approvalModeOptionsFor } from "../ApprovalModeSelector";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { ModelPicker } from "../ModelPicker";
import { RoutineEditor } from "../RoutinesPage";
import { SoulField } from "../SoulField";
import { ThreadModelsLine } from "../ThreadModelsLine";
import { useBotApps } from "../bot-settings/useBotApps";
import type { BotPatch, useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { AppsCard } from "./apps-and-logins";
import type { PageId } from "./page-registry";
import { BotSwitch, buttonCls, Card, ColRow, LabelAction, LinkRow, NavRow, NoteRow, rowCls, Segmented, SegmentedRow } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export function DetailsTab({ bot, derived, overview, onOpen }: {
  bot: Bot;
  derived: Derived;
  overview: BotOverview | null;
  onOpen: (page: PageId) => void;
}) {
  const { state, dispatch } = useStore();
  const [editingSoul, setEditingSoul] = useState(false);
  const [localAutoWarning, setLocalAutoWarning] = useState<{ botId: string; patch: BotPatch } | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | "new" | null>(null);
  const apps = useBotApps(bot);
  const { patch, approvalMode, engine, trustedModesAvailable } = derived;

  // Antigravity's old Auto still executes as Ask: show that without changing the saved mode or granting Full.
  const displayedApprovalMode = engine?.driverKind === "antigravityAgent" && approvalMode === "auto" ? "ask" : approvalMode;
  const autoOffered = approvalModeOptionsFor(engine?.driverKind ?? "", trustedModesAvailable)
    .some((option) => option.mode === "auto");
  const chooseMode = (mode: Extract<ApprovalMode, "ask" | "auto" | "full">) => {
    if (mode === approvalMode) return;
    if (mode === "full") {
      dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: "full", applyToAllThreads: true } });
      return;
    }
    if (mode === "auto" && bot.computer === "local") {
      setLocalAutoWarning({ botId: bot.id, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
      return;
    }
    patch({ approvalMode: mode });
  };
  const customMode = displayedApprovalMode === "edits" || displayedApprovalMode === "custom";
  const actsHint = customMode
    ? <span data-approval-custom>{t("botSettings.simple.customMode")}</span>
    : t(displayedApprovalMode === "auto" ? "botSettings.simple.decideHint"
      : displayedApprovalMode === "full" ? "botSettings.simple.fullHint" : "botSettings.simple.askHint");

  const effortLevels = engine?.capabilities?.modelVariants ? [] : engine?.capabilities?.effortLevels ?? [];
  const thinkingLevels = effortLevels.length > 0 ? simpleEffortLevels(effortLevels, bot.modelSelection.effort) : [];
  const chooseEffort = (level: EffortLevel) => {
    if (bot.busy || level === bot.modelSelection.effort) return;
    dispatch({ type: "setModel", botId: bot.id, selection: { ...bot.modelSelection, effort: level } });
  };

  const routines = [...derived.botRoutines].sort((a, b) =>
    Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name));
  const soulOpen = editingSoul || Boolean(bot.soulDrift);
  const setupLeft = (overview?.setup ?? []).filter((step) => !step.done).length;

  return (
    <div data-panel-tabpanel="details">
      {setupLeft > 0 && (
        <Card>
          <NavRow
            data-panel-page="setup"
            icon={Sparkles}
            title={t("botPanel.finishSetup")}
            hint={t("botPanel.finishSetupHint", { count: setupLeft, name: bot.name })}
            onClick={() => onOpen("setup")}
          />
        </Card>
      )}

      <Card label={t("model.simple.model")} anchor="model">
        <div className={cn(rowCls, "block", thinkingLevels.length > 0 && "[&_[data-simple-effort]]:hidden")} data-simple-default-model>
          {/* The open thread, as the Advanced header's picker: a Cloud guest changes only their own conversation. */}
          <ModelPicker
            key={bot.threadId}
            bot={currentTaskBot(bot)}
            threadId={bot.threadId}
            contained
            label={<span className="text-[13.5px] font-medium text-ink">{t("model.simple.model")}</span>}
          />
          <ThreadModelsLine bot={bot} className="mt-2" />
        </div>
        {thinkingLevels.length > 0 && (
          <SegmentedRow
            attr="data-thinking-choice"
            title={t("botSettings.simple.thinking")}
            hint={t(bot.modelSelection.effort === undefined ? "botSettings.simple.thinkingDefault" : "botSettings.simple.thinkingHint")}
            label={t("botSettings.simple.thinkingAria", { name: bot.name })}
            value={bot.modelSelection.effort}
            onChange={chooseEffort}
            options={thinkingLevels.map((level) => ({ value: level, label: friendlyEffort(level), disabled: Boolean(bot.busy) }))}
          />
        )}
        <LinkRow data-panel-link="model" onClick={() => onOpen("model")}>{t("botPanel.moreModel")}</LinkRow>
      </Card>

      <Card label={t("botSettings.simple.instructions")} anchor="instructions">
        {soulOpen ? (
          <ColRow data-panel-row="soul">
            <SoulField
              bot={bot}
              onPatch={patch}
              simple={{
                label: t("botSettings.simple.instructions"),
                placeholder: t("botSettings.simple.instructionsPlaceholder", { name: bot.name }),
              }}
            />
            {editingSoul && (
              <div className="flex justify-end">
                <button type="button" data-panel-done="soul" onClick={() => setEditingSoul(false)} className={buttonCls}>
                  {t("botSettings.simple.done")}
                </button>
              </div>
            )}
          </ColRow>
        ) : (
          <button
            type="button"
            data-panel-edit="soul"
            aria-label={`${t("botSettings.simple.edit")}: ${t("botSettings.simple.instructions")}`}
            onClick={() => setEditingSoul(true)}
            className={cn(rowCls, "w-full text-left hover:bg-ink/[0.03]")}
          >
            <span className={cn("line-clamp-2 min-w-0 flex-1 text-[13px]", bot.soul?.trim() ? "text-ink" : "text-ink-secondary")}>
              {firstSentence(bot.soul ?? "") || t("botSettings.simple.noInstructions")}
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[13.5px] text-ink">
              {t("botSettings.simple.edit")}
              <ChevronRight size={14} aria-hidden="true" />
            </span>
          </button>
        )}
        <SegmentedRow
          attr="data-reply-style-choice"
          title={t("botSettings.replyStyle.title")}
          label={t("botSettings.replyStyle.title")}
          value={bot.replyStyle ?? "default"}
          onChange={(replyStyle: ReplyStyle) => patch({ replyStyle })}
          options={[
            { value: "default", label: t("botSettings.replyStyle.default"), tooltip: t("botSettings.replyStyle.defaultHint") },
            { value: "conversational", label: t("botSettings.replyStyle.conversational"), tooltip: t("botSettings.replyStyle.conversationalHint") },
          ]}
        />
        <LinkRow data-panel-link="instructions" onClick={() => onOpen("instructions")}>{t("botPanel.soulAndVersions")}</LinkRow>
      </Card>

      <Card label={t("botSettings.simple.beforeActs", { name: bot.name })} anchor="approval">
        <ColRow data-panel-row="approval">
          <Segmented
            attr="data-approval-choice"
            label={t("botSettings.simple.beforeActs", { name: bot.name })}
            value={displayedApprovalMode}
            onChange={chooseMode}
            options={[
              { value: "ask", label: t("botSettings.simple.ask"), tooltip: t("botSettings.simple.askHint") },
              { value: "auto", label: t("botSettings.simple.decide"), tooltip: t("botSettings.simple.decideHint"), disabled: !autoOffered },
              { value: "full", label: t("botSettings.simple.full"), tooltip: t("botSettings.simple.fullHint") },
            ]}
          />
          <div className="mx-0.5 text-[12.5px] leading-[1.35] text-ink-secondary">{actsHint}</div>
        </ColRow>
        <LinkRow data-panel-link="approvals" onClick={() => onOpen("approvals")}>{t("botPanel.moreApprovals")}</LinkRow>
      </Card>

      <Card
        label={t("botSettings.simple.routines")}
        anchor="routines"
        action={routines.length > 0 ? (
          <LabelAction data-panel-action="routines" aria-label={t("botPanel.allRoutines")} onClick={() => onOpen("routines")}>
            {routines.length}
          </LabelAction>
        ) : undefined}
      >
        {routines.length === 0 ? (
          <NoteRow>{t("botSettings.simple.routinesEmpty", { name: bot.name })}</NoteRow>
        ) : routines.map((routine) => (
          <div key={routine.id} data-simple-routine={routine.id} className={rowCls}>
            <button type="button" onClick={() => setEditingRoutine(routine)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-[13.5px] font-medium text-ink">{routine.name}</div>
              <div className="mt-px truncate text-[12.5px] text-ink-secondary">
                {scheduleLabel(routine.schedule)} · {routineNextLabel(routine)}
              </div>
            </button>
            {!routineFinished(routine) && (
              <BotSwitch
                color={bot.color}
                checked={routine.enabled}
                aria-label={t("routines.toggle", { name: routine.name })}
                onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: !routine.enabled } })}
              />
            )}
          </div>
        ))}
        <div className={cn(rowCls, "flex-wrap gap-2")}>
          <button type="button" data-panel-action="new-routine" onClick={() => setEditingRoutine("new")} className={buttonCls}>
            <Plus size={14} aria-hidden="true" />
            {t("computer.routines.create")}
          </button>
          <button
            type="button"
            data-panel-action="routine-logs"
            onClick={() => dispatch({ type: "showRoutines", section: "logs", botId: bot.id })}
            className={buttonCls}
          >
            <FileText size={13} aria-hidden="true" />
            {t("routines.logs")}
          </button>
        </div>
        <LinkRow
          data-panel-link="schedules"
          onClick={() => dispatch({ type: "showRoutines", section: "schedule", view: "list", botId: bot.id })}
        >
          {t("computer.routines.openTitle")}
        </LinkRow>
      </Card>

      <AppsCard bot={bot} derived={derived} apps={apps} onOpenAccess={() => onOpen("apps")} />

      {editingRoutine && (
        <RoutineEditor
          key={bot.id}
          routine={editingRoutine === "new" ? undefined : editingRoutine}
          bots={[bot]}
          lockedBotId={bot.id}
          onClose={() => setEditingRoutine(null)}
        />
      )}
      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target.botId, patch: target.patch });
        }}
      />
      {state.routinesLoadState === "error" && <p role="alert" className="mx-1 mt-2 text-[12px] text-danger">{t("routines.loadError")}</p>}
    </div>
  );
}
