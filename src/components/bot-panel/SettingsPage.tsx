import { useState } from "react";
import { AppWindow, AudioLines, Bell, ChevronRight, ExternalLink, Eye, FileText, MessageSquareText, ShieldCheck, Slack, Tag } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { mcpServersForBot, useMcpServers } from "@/lib/mcp-servers";
import { CALL_MODES, callModeHint, effectiveCallMode, setCallMode, useCallMode, type CallMode } from "@/lib/call-mode";
import { callCapabilityHelp } from "@/lib/call-capability";
import { fishListeningReady, listensHere, speechBridge } from "@/lib/speech";
import { requestNotificationPermission } from "@/lib/notify";
import { firstSentence } from "@/lib/soul";
import { currentTaskBot, useStore, type Bot } from "@/state/store";
import type { ApprovalMode } from "../../../shared/approval-mode";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { REPLY_STYLES, type ReplyStyle } from "../../../shared/reply-style";
import { ApprovalChip } from "../ComposerPlusMenu";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { DefaultBotHideRow } from "../DefaultBotControls";
import { SoulField } from "../SoulField";
import { BotApiCard } from "../bot-settings/BotApiCard";
import { PackageProvenance } from "../bot-settings/PackageProvenance";
import { REPLY_STYLE_LABELS } from "../bot-settings/ReplyStyleField";
import { useChoosesVisibility, visibilityLabel } from "../bot-settings/VisibilitySection";
import { useBotApps } from "../bot-settings/useBotApps";
import { useSlackManagementUrl } from "../bot-settings/useSlackManagement";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { useThreadApproval } from "../thread-approval";
import { AdvancedSettingsRow } from "./AdvancedSettingsRow";
import { BackupAis } from "./BackupAis";
import { HeavyBotRow } from "./HeavyBotRow";
import { SoulChanges } from "./SoulChanges";
import type { SimplePageId } from "./page-registry";
import { buttonCls, Card, ColRow, NavRow, RowIcon, rowCls, RowText, Segmented, SwitchRow, TrashButton, type SegmentOption } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;

const ACTS_LABEL: Record<ApprovalMode, () => string> = {
  ask: () => t("botSettings.simple.ask"),
  full: () => t("botSettings.simple.justDoIt"),
  auto: () => t("botSettings.simple.decide"),
  edits: () => t("approvalMode.edits.label"),
  custom: () => t("botPanel.acts.custom"),
};

export function SettingsPage({ bot, derived, onOpen, editingInstructions = false, onEditInstructions }: {
  bot: Bot;
  derived: Derived;
  onOpen?: (page: SimplePageId) => void;
  editingInstructions?: boolean;
  onEditInstructions?: (open: boolean) => void;
}) {
  const { state, dispatch, flushBotPatches } = useStore();
  const { capabilities, ready } = useDesktopCapabilities();
  const apps = useBotApps(bot);
  const { servers: allServers } = useMcpServers();
  const approval = useThreadApproval(currentTaskBot(bot));
  const storedCallMode = useCallMode();
  const slackUrl = useSlackManagementUrl(bot.id);
  const choosesVisibility = useChoosesVisibility();
  const [jobDraft, setJobDraft] = useState<string | null>(null);
  const { patch, approvalMode, engine } = derived;
  const name = bot.name;
  const commitJob = () => {
    if (jobDraft !== null && jobDraft.trim() !== bot.title.trim()) patch({ title: jobDraft.trim() });
    setJobDraft(null);
  };

  // Antigravity's old Auto still executes as Ask: show that without changing the saved mode or granting Full.
  const displayedMode: ApprovalMode = engine?.driverKind === "antigravityAgent" && approvalMode === "auto" ? "ask" : approvalMode;
  const actsOptions: SegmentOption<ApprovalMode>[] = [
    { value: "ask", label: ACTS_LABEL.ask(), tooltip: t("botSettings.simple.askHint") },
    { value: "full", label: ACTS_LABEL.full(), tooltip: t("botSettings.simple.fullHint") },
    ...(displayedMode === "ask" || displayedMode === "full"
      ? []
      : [{ value: displayedMode, label: ACTS_LABEL[displayedMode](), disabled: true, tooltip: displayedMode === "custom" ? t("botPanel.acts.customHint") : undefined }]),
  ];
  const chooseActs = (mode: ApprovalMode) => {
    if (mode === approvalMode || (mode !== "ask" && mode !== "full")) return;
    dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: mode, applyToAllThreads: true } });
  };

  // As the call button: where this device cannot listen in turns, a call is always Live.
  const turnsHere = !ready || listensHere(capabilities, state.config);
  const callMode = effectiveCallMode(storedCallMode, { turnsHere, canLive: true });
  const turnsHelp = turnsHere ? null : callCapabilityHelp(capabilities, Boolean(speechBridge()?.speechStart), fishListeningReady(state.config));
  const callOptions: SegmentOption<CallMode>[] = CALL_MODES.map((entry) => ({
    value: entry.id,
    label: t(entry.label),
    disabled: entry.id === "turns" && turnsHelp !== null,
    tooltip: entry.id === "turns" && turnsHelp ? `${turnsHelp.label}. ${turnsHelp.reason}` : entry.id === "live" ? t("call.mode.liveHint") : callModeHint("turns"),
  }));

  const replyOptions: SegmentOption<ReplyStyle>[] = REPLY_STYLES.map((style) => ({
    value: style,
    label: t(REPLY_STYLE_LABELS[style][0]),
    tooltip: t(REPLY_STYLE_LABELS[style][1]),
  }));
  const toggleNotifications = () => {
    const enabled = !bot.notifications;
    if (enabled) void requestNotificationPermission();
    patch({ notifications: enabled });
  };
  const alwaysAllow = bot.alwaysAllow ?? [];

  const soulOpen = editingInstructions || Boolean(bot.soulDrift);
  const enabledApps = [
    ...apps.apps.filter((app) => app.scope !== null).map((app) => app.label),
    ...(allServers ? mcpServersForBot(allServers, bot.mcpServers, bot.id).map((server) => server.name) : []),
  ];

  return (
    <div data-panel-settings>
      <PackageProvenance bot={bot} />
      <Card anchor="instructions">
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
            <SoulChanges bot={bot} />
            {editingInstructions && (
              <div className="flex justify-end">
                <button type="button" data-panel-done="soul" onClick={() => { void flushBotPatches(bot.id); onEditInstructions?.(false); }} className={buttonCls}>
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
            onClick={() => onEditInstructions?.(true)}
            className={cn(rowCls, "w-full text-left hover:bg-ink/[0.03]")}
          >
            <RowIcon icon={FileText} />
            <RowText
              title={t("botSettings.simple.instructions")}
              hint={<span className="line-clamp-1">{firstSentence(bot.soul ?? "") || t("botPanel.instructionsHint", { name })}</span>}
            />
            <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
          </button>
        )}
      </Card>

      <HeavyBotRow bot={bot} />

      <Card anchor="approval">
        <ColRow data-panel-row="approval">
          <div className="flex items-center gap-2.5">
            <RowIcon icon={ShieldCheck} />
            <RowText title={t("botSettings.simple.beforeActs", { name })} hint={bot.busy ? t("approvalMode.whileWorking") : undefined} />
          </div>
          <div className="pl-[38px]">
            <Segmented
              attr="data-approval-choice"
              label={t("botSettings.simple.beforeActs", { name })}
              value={displayedMode}
              onChange={chooseActs}
              options={actsOptions}
            />
          </div>
          {approval.choice && (
            <div data-panel-row="thread-approval" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-[38px]">
              <span className="text-[13px] text-ink-secondary">{t("botPanel.thisConversation")}</span>
              <span className="ms-auto flex">
                <ApprovalChip choice={approval.choice} />
              </span>
            </div>
          )}
          {alwaysAllow.length > 0 && (
            <div data-panel-row="always-allow" className="flex min-w-0 flex-col gap-1 pl-[38px]">
              <span className="text-[13px] text-ink-secondary">{t("botAccess.always.title")}</span>
              {alwaysAllow.map((entry) => (
                <div key={entry} className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{entry}</span>
                  <TrashButton
                    data-panel-action={`always-allow:${entry}`}
                    label={t("botAccess.always.remove", { entry })}
                    onClick={() => patch({ alwaysAllow: alwaysAllow.filter((key) => key !== entry) })}
                  />
                </div>
              ))}
            </div>
          )}
        </ColRow>
      </Card>

      <BackupAis bot={bot} onChange={(fallback) => patch({ fallback })} />

      <Card anchor="call">
        <ColRow data-panel-row="call-mode">
          <div className="flex items-center gap-2.5">
            <RowIcon icon={AudioLines} />
            <RowText title={t("call.mode.menu")} />
          </div>
          <div className="pl-[38px]">
            <Segmented attr="data-call-mode" label={t("call.mode.menu")} value={callMode} onChange={setCallMode} options={callOptions} />
          </div>
        </ColRow>
      </Card>

      <Card anchor="replies">
        <ColRow data-panel-row="reply-style">
          <div className="flex items-center gap-2.5">
            <RowIcon icon={MessageSquareText} />
            <RowText title={t("botSettings.replyStyle.title")} />
          </div>
          <div className="pl-[38px]">
            <Segmented
              attr="data-reply-style"
              label={t("botSettings.replyStyle.title")}
              value={bot.replyStyle ?? "default"}
              onChange={(style) => patch({ replyStyle: style })}
              options={replyOptions}
            />
          </div>
        </ColRow>
        <SwitchRow
          data-panel-row="notifications"
          icon={Bell}
          title={t("voice.notifications.title")}
          color={bot.color}
          checked={bot.notifications}
          onChange={toggleNotifications}
        />
      </Card>

      <Card anchor="uses">
        <NavRow
          data-panel-page="apps"
          icon={AppWindow}
          title={t("botPanel.appsRow")}
          value={enabledApps.length > 0 ? enabledApps.join(", ") : t("botPanel.appsNoneYet")}
          onClick={() => onOpen?.("apps")}
        />
        <label data-panel-row="job" className={cn(rowCls, "cursor-text")}>
          <RowIcon icon={Tag} />
          <span className="shrink-0 text-[14px] font-medium text-ink">{t("botSettings.simple.job")}</span>
          <input
            data-panel-job
            value={jobDraft ?? bot.title}
            placeholder={t("botSettings.simple.jobPlaceholder")}
            aria-label={t("botSettings.simple.job")}
            maxLength={BOT_PROFILE_LIMITS.title}
            onChange={(event) => setJobDraft(event.target.value)}
            onBlur={commitJob}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape" && jobDraft !== null) {
                event.preventDefault();
                event.stopPropagation();
                setJobDraft(null);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-right text-[13px] text-ink-secondary outline-none placeholder:text-ink-tertiary focus:text-ink"
          />
        </label>
        {slackUrl && (
          <a data-panel-row="slack" href={slackUrl} target="_blank" rel="noopener noreferrer" className={cn(rowCls, "hover:bg-ink/[0.03]")}>
            <RowIcon icon={Slack} />
            <RowText title={t("botPanel.page.slack")} hint={t("botSlack.manage")} />
            <ExternalLink size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
          </a>
        )}
        {choosesVisibility && (
          <NavRow
            data-panel-page="visibility"
            icon={Eye}
            title={t("botSettings.visibility.title")}
            value={visibilityLabel(bot.visibility)}
            onClick={() => onOpen?.("visibility")}
          />
        )}
      </Card>

      <AdvancedSettingsRow />

      <BotApiCard bot={bot} webhooksLink className="mt-3.5" />

      <DefaultBotHideRow bot={bot} />
      {approval.dialogs}
    </div>
  );
}
