import { AppWindow, Brain, Calendar, ChevronRight, FileText, Folder, Sparkles, Zap } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { effortLabel } from "@/components/ModelPicker";
import { shortPath } from "@/lib/short-path";
import { firstSentence } from "@/lib/soul";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import type { ApprovalMode } from "../../../shared/approval-mode";
import type { EffortLevel } from "../../../shared/wire";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { DefaultBotHideRow } from "../DefaultBotControls";
import { ModelPicker, ModelVariantRow } from "../ModelPicker";
import { SoulField } from "../SoulField";
import { useManagedSkills } from "../bot-settings/SkillsSection";
import { useBotApps } from "../bot-settings/useBotApps";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { BotConversations } from "./Conversations";
import { memoryNotes } from "./memory-notes";
import type { SimplePageId } from "./page-registry";
import { buttonCls, Card, ColRow, NavRow, rowCls, RowText, Segmented, type SegmentOption } from "./rows";
import { useMemoryDoc } from "./use-memory-doc";

type Derived = ReturnType<typeof useBotSettingsDerived>;
type ActsChoice = Extract<ApprovalMode, "ask" | "full">;

const ACTS_LABEL: Record<ApprovalMode, () => string> = {
  ask: () => t("botSettings.simple.ask"),
  full: () => t("botSettings.simple.justDoIt"),
  auto: () => t("botSettings.simple.decide"),
  edits: () => t("approvalMode.edits.label"),
  custom: () => t("approvalMode.custom.label"),
};

export function BotTab({ bot, derived, editingInstructions, onEditInstructions, onOpen }: {
  bot: Bot;
  derived: Derived;
  editingInstructions: boolean;
  onEditInstructions: (open: boolean) => void;
  onOpen: (page: SimplePageId) => void;
}) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const ownerOrAdmin = useOwnerOrAdmin();
  const apps = useBotApps(bot);
  const skills = useManagedSkills(bot);
  const memory = useMemoryDoc(bot);
  const { patch, approvalMode, engine } = derived;
  const name = bot.name;

  // Antigravity's old Auto still executes as Ask: show that without changing the saved mode or granting Full.
  const displayedMode: ApprovalMode = engine?.driverKind === "antigravityAgent" && approvalMode === "auto" ? "ask" : approvalMode;
  const actsOptions: SegmentOption<ApprovalMode>[] = [
    { value: "ask", label: ACTS_LABEL.ask(), tooltip: t("botSettings.simple.askHint"), disabled: Boolean(bot.busy) },
    { value: "full", label: ACTS_LABEL.full(), tooltip: t("botSettings.simple.fullHint"), disabled: Boolean(bot.busy) },
    ...(displayedMode === "ask" || displayedMode === "full"
      ? []
      : [{ value: displayedMode, label: ACTS_LABEL[displayedMode](), disabled: true }]),
  ];
  const chooseActs = (mode: ApprovalMode) => {
    if (bot.busy || mode === approvalMode || (mode !== "ask" && mode !== "full")) return;
    const chosen: ActsChoice = mode;
    if (chosen === "full") {
      dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: "full", applyToAllThreads: true } });
      return;
    }
    patch({ approvalMode: chosen });
  };

  // The Simple picker's own Thinking steps, so the row and the picker never disagree.
  const selection = bot.modelSelection;
  const levels = engine?.capabilities?.effortLevels ?? [];
  const updatesBotDefault = ownerOrAdmin === true;
  const thinking = engine?.capabilities?.modelVariants ? (
    <ColRow data-panel-row="thinking">
      <RowText title={t("botSettings.simple.thinking")} />
      <ModelVariantRow compact wide bot={bot} threadId={bot.threadId} updateBotDefault={updatesBotDefault} />
    </ColRow>
  ) : levels.length > 0 ? (
    <ColRow data-panel-row="thinking">
      <RowText title={t("botSettings.simple.thinking")} />
      <Segmented
        attr="data-thinking-choice"
        label={t("botSettings.simple.thinkingAria", { name })}
        value={selection.effort}
        onChange={(level: EffortLevel) => dispatch({
          type: "setModel",
          botId: bot.id,
          threadId: bot.threadId,
          ...(updatesBotDefault ? { updateBotDefault: true } : {}),
          selection: { ...selection, effort: level },
        })}
        // The provider's own level names (claude --effort / codex reasoning effort), every one the engine reports: no relabelling.
        options={levels.map((level) => ({ value: level, label: effortLabel(level), disabled: Boolean(bot.busy) }))}
      />
    </ColRow>
  ) : null;

  const soulOpen = editingInstructions || Boolean(bot.soulDrift);
  const enabledApps = apps.apps.filter((app) => app.scope !== null).map((app) => app.label);
  const routinesOn = derived.botRoutines.filter((routine) => routine.enabled).length;
  const skillsOn = skills.skills.filter((skill) => skill.enabled).length;
  const memoryOn = bot.memoryEnabled !== false;
  const notes = memory.doc ? memoryNotes(memory.doc.text).length : null;
  const memoryValue = !memoryOn ? t("botPanel.memory.off")
    : notes === null ? (memory.error ? t("botPanel.memory.nothingYet") : undefined)
    : notes === 0 ? t("botPanel.memory.nothingYet")
    : notes === 1 ? t("botPanel.memory.note") : t("botPanel.memory.notes", { count: notes });

  return (
    <div data-panel-tabpanel="bot">
      <BotConversations bot={bot} />
      <Card anchor="model">
        <div data-panel-row="model" className={rowCls}>
          <ModelPicker
            bot={bot}
            contained
            threadId={bot.threadId}
            label={<RowText title={<span className="flex items-center gap-2.5"><Sparkles size={15} className="text-ink-secondary" aria-hidden="true" />{t("model.simple.model")}</span>} />}
          />
        </div>
        {thinking}
        {soulOpen ? (
          <ColRow data-panel-row="soul">
            <SoulField
              bot={bot}
              onPatch={patch}
              simple={{
                label: t("botSettings.simple.instructions"),
                placeholder: t("botSettings.simple.instructionsPlaceholder", { name }),
              }}
            />
            {editingInstructions && (
              <div className="flex justify-end">
                <button type="button" data-panel-done="soul" onClick={() => onEditInstructions(false)} className={buttonCls}>
                  {t("botSettings.simple.done")}
                </button>
              </div>
            )}
          </ColRow>
        ) : (
          <section data-panel-card="instructions">
            <button
              type="button"
              data-panel-edit="soul"
              aria-label={`${t("botSettings.simple.edit")}: ${t("botSettings.simple.instructions")}`}
              onClick={() => onEditInstructions(true)}
              className={cn(rowCls, "w-full text-left hover:bg-ink/[0.03]")}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] text-ink-secondary" aria-hidden="true">
                <FileText size={15} />
              </span>
              <RowText
                title={t("botSettings.simple.instructions")}
                hint={<span className="line-clamp-1">{firstSentence(bot.soul ?? "") || t("botPanel.instructionsHint", { name })}</span>}
              />
              <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
            </button>
          </section>
        )}
        <section data-panel-card="approval">
          <ColRow data-panel-row="approval">
            <RowText title={t("botSettings.simple.beforeActs", { name })} />
            <Segmented
              attr="data-approval-choice"
              label={t("botSettings.simple.beforeActs", { name })}
              value={displayedMode}
              onChange={chooseActs}
              options={actsOptions}
            />
          </ColRow>
        </section>
        <NavRow
          data-panel-page="apps"
          icon={AppWindow}
          title={t("botPanel.appsRow")}
          value={enabledApps.length > 0 ? enabledApps.join(", ") : t("botPanel.appsNoneYet")}
          onClick={() => onOpen("apps")}
        />
      </Card>

      <Card anchor="library">
        <NavRow
          data-panel-page="routines"
          icon={Calendar}
          title={t("botSettings.simple.routines")}
          value={routinesOn > 0 ? t("botPanel.routinesOn", { count: routinesOn }) : t("botPanel.none")}
          onClick={() => onOpen("routines")}
        />
        <NavRow
          data-panel-page="memory"
          icon={Brain}
          title={t("botPanel.memoryRow")}
          value={memoryValue}
          onClick={() => onOpen("memory")}
        />
        <NavRow
          data-panel-page="skills"
          icon={Zap}
          title={t("botSettings.simple.skills")}
          value={skills.loading ? undefined : skillsOn > 0 ? skillsOn : t("botPanel.none")}
          onClick={() => onOpen("skills")}
        />
        <NavRow
          data-panel-page="folder"
          icon={Folder}
          title={t("computer.files.folder")}
          value={bot.cwd ? shortPath(bot.cwd, capabilities.host?.homeDir) : t("botPanel.folder.private")}
          onClick={() => onOpen("folder")}
        />
      </Card>
      <DefaultBotHideRow bot={bot} />
    </div>
  );
}
