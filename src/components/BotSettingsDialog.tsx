import { SettingsSectionRow } from "./bot-settings/SettingsSectionRow";
import { keyboardFocusTarget } from "@/lib/keyboard-focus-target";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Search } from "lucide-react";
import { useStore, type Bot, type BotSettingsSection } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "./DesktopCapabilities";
import { BOT_SECTIONS, appSearchPhase, searchEmptyText, sectionLabel, sectionMatches } from "./bot-settings/sections";
import { useBotApps } from "./bot-settings/useBotApps";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { OverviewSection } from "./bot-settings/OverviewSection";
import { IdentitySection } from "./bot-settings/IdentitySection";
import { SlackSection } from "./bot-settings/SlackSection";
import { useSlackManagementUrl } from "./bot-settings/useSlackManagement";
import { SoulSection } from "./bot-settings/SoulSection";
import { SkillsSection } from "./bot-settings/SkillsSection";
import { MemorySection } from "./bot-settings/MemorySection";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { AccessSection } from "./bot-settings/AccessSection";
import { ModelSection } from "./bot-settings/ModelSection";
import { PermissionsSection } from "./bot-settings/PermissionsSection";
import { VoiceSection } from "./bot-settings/VoiceSection";
import { HistorySection } from "./bot-settings/HistorySection";
import { UsageSection } from "./bot-settings/UsageSection";
import { VisibilitySection } from "./bot-settings/VisibilitySection";
import { t } from "@/lib/i18n";
import { LibraryTab, type LibraryPage } from "./bot-panel/LibraryTab";
import { RightSidePanel, RightSidePanelHeader } from "./RightSidePanel";
import { HistoryRollbackDialog, useBotHistory, useBotOverview } from "./bot-settings/useBotOverview";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { ShareBotButton, useTeamName } from "./bot-access/ShareBotButton";

/** Where the Library's memory, skills and folder rows lead in Advanced settings. */
const LIBRARY_LINKS: Record<LibraryPage, BotSettingsSection> = { memory: "memory", skills: "skills", folder: "access" };

export function BotSettingsDialog({ bot, overlay = false, closing = false }: {
  bot: Bot;
  overlay?: boolean;
  closing?: boolean;
}) {
  const { state, dispatch } = useStore();
  const section = state.botSettingsSection;
  const derived = useBotSettingsDerived(bot);
  const dialogRef = useRef<HTMLElement | null>(null);
  const { dragProps } = useCaptionChrome();
  const [query, setQuery] = useState("");
  const collapsed = !state.botSettingsExpandAccordion;
  const q = query.trim().toLowerCase();


  const slackUrl = useSlackManagementUrl(bot.id);
  const ownerOrAdmin = useOwnerOrAdmin();
  const teamName = useTeamName();
  const sections = BOT_SECTIONS
    .filter((entry) => entry.id !== "slack" || slackUrl !== null)
    .filter((entry) => entry.id !== "visibility" || (!window.ogb && ownerOrAdmin === true && !teamName));
  // Connected apps load only once the person searches; their names find the Access section.
  const searchApps = useBotApps(bot, q !== "");
  const appNames = searchApps.apps.flatMap((app) => [app.label, app.slug]);
  const visibleSections = sections.filter((entry) => sectionMatches(entry, q, appNames));

  const { overview, overviewError, prompt, promptError } = useBotOverview(bot, {
    overview: section === "overview",
    prompt: section === "overview",
  });
  const history = useBotHistory(bot, section === "history");

  useEffect(() => {
    if (collapsed) return;
    if (q) { setQuery(""); return; }
    dialogRef.current?.querySelector(`[data-bot-settings-section="${section}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [collapsed, section, q]);

  useEffect(() => {
    if (closing) return;
    const previousFocus = keyboardFocusTarget();
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      const nested = dialog?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length > 0) return;
      // BotInstructionsDialog portals to document.body: a key pressed with focus outside this dialog is not ours.
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      // A popover or field inside that already handled this Escape keeps the panel open.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        dispatch({ type: "toggleSettings", open: false });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [closing, dispatch]);

  const renderSectionBody = (id: (typeof BOT_SECTIONS)[number]["id"]) => {
    switch (id) {
      case "overview":
        return overview === null && overviewError ? (
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">{t("botSettings.overviewFailed")}</div>
        ) : (
          <OverviewSection
            overview={overview}
            refreshError={overview !== null && overviewError}
            prompt={prompt}
            promptError={promptError}
            onOpen={(target) => dispatch({ type: "toggleSettings", open: true, section: target })}
            onSetup={derived.canCoordinate && !bot.busy ? () => {
              dispatch({ type: "toggleSettings", open: false });
              dispatch({ type: "send", botId: bot.id, text: "/setup", threadId: bot.threadId });
            } : undefined}
          />
        );
      case "identity":
        return (
          <IdentitySection
            bot={bot}
            patch={derived.patch}
            activeState={derived.activeState}
            mascotMotion={derived.mascotMotion}
          />
        );
      case "soul":
        return <SoulSection bot={bot} patch={derived.patch} />;
      case "slack":
        return slackUrl ? <SlackSection managementUrl={slackUrl} /> : null;
      case "skills":
        return <SkillsSection bot={bot} />;
      case "memory":
        return <MemorySection bot={bot} active={!collapsed && section === "memory"} onToggle={(enabled) => derived.patch({ memoryEnabled: enabled })} />;
      case "library":
        return <LibraryTab bot={bot} onOpen={(page) => dispatch({ type: "toggleSettings", open: true, section: LIBRARY_LINKS[page] ?? "overview" })} />;
      case "routines":
        return <RoutinesSection bot={bot} routines={derived.botRoutines} runs={state.routineRuns} />;
      case "access":
        return <AccessSection bot={bot} derived={derived} />;
      case "model":
        return <ModelSection bot={bot} />;
      case "permissions":
        return <PermissionsSection bot={bot} derived={derived} />;
      case "voice":
        return <VoiceSection bot={bot} derived={derived} />;
      case "visibility":
        return <VisibilitySection bot={bot} />;
      case "history":
        return history.rows === null && history.error ? (
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">{t("botSettings.historyFailed")}</div>
        ) : (
          <HistorySection
            bot={bot}
            rows={history.rows}
            refreshError={history.rows !== null && history.error}
            onRollback={history.requestRollback}
            rollingBack={history.rollingBack || !history.revision}
          />
        );
      case "usage":
        return <UsageSection bot={bot} />;
      default:
        return null;
    }
  };

  return (
    <>
      <RightSidePanel
        ref={dialogRef}
        role="dialog"
        aria-labelledby="bot-settings-title"
        tabIndex={-1}
        data-side-panel-motion={closing ? "out" : "in"}
        inert={closing}
        aria-hidden={closing || undefined}
        style={{ "--side-panel-width": "min(420px, 42vw)" } as CSSProperties}
        className={cn("absolute inset-0 z-40 min-w-0 outline-none max-md:w-full!", overlay ? "md:inset-y-0 md:left-auto md:right-0 md:shadow-2xl" : "md:static md:z-auto")}
      >
        <RightSidePanelHeader {...dragProps} className="mb-4 px-4" label={t("botSettings.simple.close")} onClose={() => dispatch({ type: "toggleSettings", open: false })}>
          <span id="bot-settings-title" className="flex h-[34px] min-w-0 flex-1 items-center truncate text-[16px] font-semibold tracking-tight text-ink">
            {bot.name}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <ShareBotButton bot={bot} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" />
          </span>
        </RightSidePanelHeader>

        <div className="mx-4 mb-4 flex h-9 shrink-0 items-center gap-2 rounded-full bg-control/70 px-3 ring-1 ring-inset ring-hairline/40 focus-within:ring-focus">
          <Search size={14} className="shrink-0 text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              dispatch({ type: "toggleSettings", open: true });
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              if (query) setQuery("");
              else dispatch({ type: "toggleSettings", open: false });
            }}
            placeholder={t("botSettings.search")}
            aria-label={t("botSettings.searchAria")}
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
          {visibleSections.length === 0 && (
            <div className="px-4 py-4 text-[13px] leading-relaxed text-ink-secondary">
              {searchEmptyText(query.trim(), appSearchPhase(searchApps))}
            </div>
          )}
          {sections.map((entry) => {
            const { id, icon: Icon } = entry;
            const label = sectionLabel(entry);
            const matched = sectionMatches(entry, q, appNames);
            if (!matched && id !== "memory") return null;
            const open = !collapsed && section === id;
            return (
              <SettingsSectionRow key={id} id={id} icon={Icon} label={label} open={open} hidden={!matched}
                keepMounted={id === "memory"}
                onToggle={() => dispatch({
                  type: "toggleSettings",
                  open: true,
                  section: open ? undefined : id,
                })}
              >
                {renderSectionBody(id)}
              </SettingsSectionRow>
            );
          })}
        </div>
      </RightSidePanel>
      <HistoryRollbackDialog history={history} returnFocusRef={dialogRef} />
    </>
  );
}
