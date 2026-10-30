import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "./DesktopCapabilities";
import { BOT_SECTIONS } from "./bot-settings/sections";
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
import { useAdvancedMode } from "@/lib/interface-mode";
import { BotPanel } from "./bot-panel/PanelShell";
import { BOT_PANEL_ID, sidePanelCls } from "./bot-panel/side-panel";
import { HistoryRollbackDialog, useBotHistory, useBotOverview } from "./bot-settings/useBotOverview";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";

const sectionLabel = (entry: (typeof BOT_SECTIONS)[number]) => (entry.labelKey ? t(entry.labelKey) : entry.label);

function sectionMatches(entry: (typeof BOT_SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [entry.label, sectionLabel(entry), ...entry.keywords].some((part) => part.toLowerCase().includes(query));
}

export function BotSettingsDialog({ bot, overlay = false }: {
  bot: Bot;
  overlay?: boolean;
}) {
  const { state, dispatch } = useStore();
  const section = state.botSettingsSection;
  const derived = useBotSettingsDerived(bot);
  const dialogRef = useRef<HTMLElement | null>(null);
  const { padClass, dragProps } = useCaptionChrome();
  const [query, setQuery] = useState("");
  const collapsed = !state.botSettingsExpandAccordion;
  const q = query.trim().toLowerCase();
  const advanced = useAdvancedMode();
  const simpleView = !advanced;
  const linkedSection = !collapsed && !state.botSettingsExpandRemembered ? section : null;
  const slackUrl = useSlackManagementUrl(bot.id);
  const ownerOrAdmin = useOwnerOrAdmin();
  const sections = BOT_SECTIONS
    .filter((entry) => entry.id !== "slack" || slackUrl !== null)
    .filter((entry) => entry.id !== "visibility" || (!window.ogb && ownerOrAdmin === true));
  const visibleSections = sections.filter((entry) => sectionMatches(entry, q));

  const { overview, overviewError, prompt, promptError } = useBotOverview(bot, {
    overview: section === "overview" && !simpleView,
    prompt: section === "overview" && !simpleView,
  });
  const history = useBotHistory(bot, section === "history" && !simpleView);

  useEffect(() => {
    if (collapsed) return;
    if (q) { setQuery(""); return; }
    dialogRef.current?.querySelector(`[data-bot-settings-section="${section}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [collapsed, section, q]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  }, [dispatch]);

  const renderSectionBody = (id: (typeof BOT_SECTIONS)[number]["id"]) => {
    switch (id) {
      case "overview":
        return overview === null && overviewError ? (
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">Couldn’t load the overview.</div>
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
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">Couldn’t load history.</div>
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
      <aside
        ref={dialogRef}
        id={simpleView ? BOT_PANEL_ID : undefined}
        role="dialog"
        aria-labelledby="bot-settings-title"
        tabIndex={-1}
        className={sidePanelCls(overlay, simpleView)}
      >
        {simpleView ? (
          <BotPanel
            bot={bot}
            derived={derived}
            headerClassName={padClass}
            linkedSection={linkedSection}
            onClose={() => dispatch({ type: "toggleSettings", open: false })}
          />
        ) : <>
        <div {...dragProps} className={cn("flex shrink-0 items-center justify-between px-4 py-3", padClass)}>
          <span id="bot-settings-title" className="truncate text-[15px] font-semibold text-ink">
            {bot.name}
          </span>
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleSettings", open: false })}
            aria-label="Close settings"
            className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={18} className="pointer-events-none" />
          </button>
        </div>

        <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-transparent bg-control/70 px-2.5 py-2 focus-within:border-focus">
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

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {visibleSections.length === 0 && (
            <div className="px-4 py-4 text-[13px] leading-relaxed text-ink-secondary">
              {t("botSettings.searchNone", { query: query.trim() })}
            </div>
          )}
          {sections.map((entry) => {
            const { id, icon: Icon } = entry;
            const label = sectionLabel(entry);
            const matched = sectionMatches(entry, q);
            if (!matched && id !== "memory") return null;
            const open = !collapsed && section === id;
            return (
              <div
                key={id}
                data-bot-settings-section={id}
                className="border-b border-hairline/30"
                hidden={!matched}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (section === id && !collapsed) {
                      dispatch({ type: "toggleSettings", open: true });
                      return;
                    }
                    dispatch({ type: "toggleSettings", open: true, section: id });
                  }}
                  aria-expanded={open}
                  className={cn(
                    "flex w-full shrink-0 items-center gap-2.5 px-4 py-2.5 text-left text-[14px]",
                    open ? "bg-control/60 text-ink" : "text-ink-secondary hover:bg-control/40 hover:text-ink",
                  )}
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <ChevronDown
                    size={16}
                    className={cn(
                      "shrink-0 text-ink-secondary transition-transform",
                      open && "rotate-180",
                    )}
                  />
                </button>
                {/* Memory stays mounted (hidden when collapsed) so its unsaved draft survives. */}
                {id === "memory" ? (
                  <div hidden={!open} className="px-4 pb-4 pt-1">
                    {renderSectionBody("memory")}
                  </div>
                ) : (
                  open && <div className="px-4 pb-4 pt-1">{renderSectionBody(id)}</div>
                )}
              </div>
            );
          })}
        </div>
        </>}
      </aside>
      <HistoryRollbackDialog history={history} returnFocusRef={dialogRef} />
    </>
  );
}
