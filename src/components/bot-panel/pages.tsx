import { useState, type ReactNode } from "react";
import { AppWindow, Calendar, Check, FileText, Folder, FolderOpen, History, KeyRound, Sparkles, User } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SetupStep } from "@/lib/bot-overview-types";
import { useStore, type Bot, type BotSettingsSection } from "@/state/store";
import { AndroidDevicePanel, useAndroidUsbDevices } from "../AndroidDevicePanel";
import { AccessSection } from "../bot-settings/AccessSection";
import { HistorySection } from "../bot-settings/HistorySection";
import { IdentitySection } from "../bot-settings/IdentitySection";
import { ManagedTeamsSettings } from "../bot-settings/ManagedTeamsSettings";
import { ModelSection } from "../bot-settings/ModelSection";
import { OverviewSection } from "../bot-settings/OverviewSection";
import { PermissionsSection } from "../bot-settings/PermissionsSection";
import { PromptPreview } from "../bot-settings/PromptPreview";
import { ProposalStatus } from "../bot-settings/ProposalStatus";
import { RoutinesSection } from "../bot-settings/RoutinesSection";
import { SkillsSection } from "../bot-settings/SkillsSection";
import { SlackSection } from "../bot-settings/SlackSection";
import { SoulSection } from "../bot-settings/SoulSection";
import { VisibilitySection } from "../bot-settings/VisibilitySection";
import { VoiceSection } from "../bot-settings/VoiceSection";
import type { useBotHistory, useBotOverview } from "../bot-settings/useBotOverview";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { BrowserLogins } from "./apps-and-logins";
import { teamNames, useBotActions } from "./bot-actions";
import { useOpenComputer } from "./ComputerTab";
import { PAGES, sectionTarget, setupTarget, type PageId, type PanelTarget } from "./page-registry";
import { buttonCls, Card, ItemRow, LinkRow, NavRow, NoteRow, rowCls } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export interface PageContext {
  bot: Bot;
  derived: Derived;
  slackUrl: string | null;
  overview: ReturnType<typeof useBotOverview>;
  history: ReturnType<typeof useBotHistory>;
  onOpen: (page: PageId) => void;
  onGo: (target: PanelTarget) => void;
}

export const pageSurfaceCls = "flex flex-col gap-3 [&_.bg-card]:bg-ink/[0.03] [&_.rounded-xl.bg-card]:border [&_.rounded-xl.bg-card]:border-ink/[0.04]";

const SETUP_ICON: Record<SetupStep["id"], typeof Sparkles> = {
  identity: User,
  soul: FileText,
  folder: Folder,
  apps: AppWindow,
  schedule: Calendar,
};

export function SetupPage({ bot, derived, overview, onOpen, onGo }: PageContext) {
  const { dispatch } = useStore();
  const steps = (overview.overview?.setup ?? []).filter((step) => !step.done);
  const go = (target: PanelTarget) => (target.page ? onOpen(target.page) : onGo(target));
  if (!overview.overview) return <NoteRow>{t(overview.overviewError ? "botPanel.overviewError" : "botPanel.loading")}</NoteRow>;
  return (
    <>
      <Card>
        {steps.length === 0 ? <NoteRow>{t("botPanel.setupDone")}</NoteRow> : steps.map((step) => (
          <NavRow
            key={step.id}
            data-panel-setup={step.id}
            icon={SETUP_ICON[step.id]}
            title={step.label}
            onClick={() => go(setupTarget(step.id))}
          />
        ))}
      </Card>
      {derived.canCoordinate && !bot.busy && (
        <Card>
          <ItemRow icon={Sparkles} title={t("botSetup.withBot")} hint={t("botSetup.help")}>
            <button
              type="button"
              data-panel-action="setup"
              onClick={() => {
                dispatch({ type: "toggleSettings", open: false });
                dispatch({ type: "send", botId: bot.id, text: "/setup", threadId: bot.threadId });
              }}
              className={cn(buttonCls, "bg-accent text-accent-ink hover:bg-accent hover:brightness-110")}
            >
              {t("botPanel.start")}
            </button>
          </ItemRow>
        </Card>
      )}
    </>
  );
}

function TeamPage({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const { moveToTeam } = useBotActions(bot);
  const [draft, setDraft] = useState("");
  const current = bot.section?.trim() ?? "";
  const teams = teamNames(state);
  const trimmed = draft.trim();
  const choice = (team: string, label: string) => (
    <button
      key={team || "general"}
      type="button"
      data-panel-team={team}
      aria-pressed={current === team}
      onClick={() => moveToTeam(team)}
      className={cn(rowCls, "w-full text-left hover:bg-ink/[0.03]")}
    >
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{label}</span>
      <span className="flex w-4 shrink-0 text-ink">{current === team && <Check size={16} aria-hidden="true" />}</span>
    </button>
  );
  return (
    <>
      <Card>
        {choice("", t("botPanel.generalTeam"))}
        {teams.map((team) => choice(team, team))}
      </Card>
      <Card>
        <form
          className={rowCls}
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed || trimmed.length > 60) return;
            moveToTeam(trimmed);
            setDraft("");
          }}
        >
          <input
            maxLength={60}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("sidebar.section.newContext")}
            aria-label={t("sidebar.section.newContextAria")}
            className="h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border"
          />
          <button type="submit" disabled={!trimmed} className={buttonCls}>{t("common.add")}</button>
        </form>
      </Card>
    </>
  );
}

function AndroidPage() {
  const status = useAndroidUsbDevices();
  return <AndroidDevicePanel status={status} />;
}

function PromptPage({ overview }: Pick<PageContext, "overview">) {
  const [open, setOpen] = useState(true);
  return <PromptPreview data={overview.prompt} error={overview.promptError} open={open} onToggle={() => setOpen((current) => !current)} />;
}

function FolderPage({ bot, derived }: Pick<PageContext, "bot" | "derived">) {
  const openComputer = useOpenComputer(bot);
  return (
    <>
      <AccessSection bot={bot} derived={derived} parts={["folder"]} />
      <Card>
        <LinkRow data-panel-link="files" icon={FolderOpen} onClick={() => openComputer("files")}>{t("botPanel.changedFiles")}</LinkRow>
      </Card>
    </>
  );
}

function BrowserPage({ bot, derived }: Pick<PageContext, "bot" | "derived">) {
  const openComputer = useOpenComputer(bot);
  return (
    <>
      <AccessSection bot={bot} derived={derived} parts={["browser"]} />
      <BrowserLogins bot={bot} browserEnabled={derived.browserEnabled} onOpenBrowser={() => openComputer("browser")} />
    </>
  );
}

function ChiefTeamsPage({ bot, derived }: Pick<PageContext, "bot" | "derived">) {
  const { state } = useStore();
  if (!bot.chiefOfStaff) return <NoteRow>{t("botPanel.chiefFirst")}</NoteRow>;
  return (
    <div className="rounded-xl bg-card p-4 [&>details]:mt-0 [&>details]:border-0 [&>details]:pt-0">
      <ManagedTeamsSettings
        key={bot.id + JSON.stringify(bot.managedSections ?? [])}
        name={bot.name} ownTeam={bot.section?.trim() || ""}
        teams={["", ...(state.sections ?? []), ...[...state.bots, ...state.groups].map(member => member.section?.trim() || "")]}
        allowed={bot.managedSections ?? []}
        onSave={managedSections => derived.patch({ managedSections, acknowledgePeerScope: true })}
      />
      <ProposalStatus bot={bot} kind="owner" />
    </div>
  );
}

export function PageBody({ page, ...context }: PageContext & { page: PageId }): ReactNode {
  const { bot, derived, slackUrl, overview, history, onOpen, onGo } = context;
  const { state, dispatch } = useStore();
  const openSection = (section: BotSettingsSection) => {
    const target = sectionTarget(section);
    if (target.page) onOpen(target.page);
    else onGo(target);
  };
  switch (page) {
    case "setup":
      return <SetupPage {...context} />;
    case "model":
      return (
        <>
          <ModelSection bot={bot} />
          <Card>
            <NavRow
              data-panel-row="providers"
              icon={KeyRound}
              title={t("botPanel.providers")}
              hint={t("botPanel.providersHint")}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
            />
          </Card>
        </>
      );
    case "instructions":
      return (
        <>
          <SoulSection bot={bot} patch={derived.patch} />
          <Card>
            <NavRow data-panel-page="history" icon={History} title={t("botPanel.earlierVersions")} hint={t("botPanel.earlierVersionsHint")} onClick={() => onOpen("history")} />
          </Card>
        </>
      );
    case "approvals":
      return (
        <>
          <PermissionsSection bot={bot} derived={derived} parts={["approval", "outbound"]} />
          <Card>
            <NavRow
              data-panel-page="always"
              icon={Check}
              title={t(PAGES.always.title)}
              hint={t("botPanel.alwaysHint")}
              value={bot.alwaysAllow?.length || t("botPanel.none")}
              onClick={() => onOpen("always")}
            />
          </Card>
        </>
      );
    case "always":
      return <AccessSection bot={bot} derived={derived} parts={["always"]} />;
    case "routines":
      return <RoutinesSection bot={bot} routines={derived.botRoutines} runs={state.routineRuns} />;
    case "apps":
      return <AccessSection bot={bot} derived={derived} parts={["apps", "xResearch"]} />;
    case "memory":
      return null;
    case "skills":
      return <SkillsSection bot={bot} />;
    case "browser":
      return <BrowserPage bot={bot} derived={derived} />;
    case "folder":
      return <FolderPage bot={bot} derived={derived} />;
    case "android":
      return <AndroidPage />;
    case "voice":
      return <VoiceSection bot={bot} derived={derived} />;
    case "blurb":
      return (
        <IdentitySection
          bot={bot}
          patch={derived.patch}
          activeState={derived.activeState}
          mascotMotion={derived.mascotMotion}
          parts={["provenance", "blurb"]}
        />
      );
    case "team":
      return <TeamPage bot={bot} />;
    case "chiefteams":
      return <ChiefTeamsPage bot={bot} derived={derived} />;
    case "mcp":
      return <AccessSection bot={bot} derived={derived} parts={["mcp"]} />;
    case "tools":
      return <AccessSection bot={bot} derived={derived} parts={["tools"]} />;
    case "webhooks":
      return <AccessSection bot={bot} derived={derived} parts={["webhooks"]} />;
    case "visibility":
      return <VisibilitySection bot={bot} />;
    case "slack":
      return slackUrl ? <SlackSection managementUrl={slackUrl} /> : <NoteRow>{t("botPanel.slackUnavailable")}</NoteRow>;
    case "overview":
      return overview.overview === null && overview.overviewError ? (
        <NoteRow>{t("botPanel.overviewError")}</NoteRow>
      ) : (
        <OverviewSection
          overview={overview.overview}
          refreshError={overview.overview !== null && overview.overviewError}
          prompt={overview.prompt}
          promptError={overview.promptError}
          onOpen={openSection}
          onSetup={derived.canCoordinate && !bot.busy ? () => {
            dispatch({ type: "toggleSettings", open: false });
            dispatch({ type: "send", botId: bot.id, text: "/setup", threadId: bot.threadId });
          } : undefined}
        />
      );
    case "prompt":
      return <PromptPage overview={overview} />;
    case "history":
      return history.rows === null && history.error ? (
        <NoteRow>{t("botPanel.historyError")}</NoteRow>
      ) : (
        <HistorySection
          bot={bot}
          rows={history.rows}
          refreshError={history.rows !== null && history.error}
          onRollback={history.requestRollback}
          rollingBack={history.rollingBack || !history.revision}
        />
      );
  }
}
