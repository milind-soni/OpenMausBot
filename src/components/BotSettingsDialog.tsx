// Per-bot settings as a right sidebar with fold-out (accordion) categories —
// same shell pattern as InspectorPanel. Every section lives under
// bot-settings/; this dialog owns only the fetches (overview, system-prompt,
// history) and which accordion row is expanded.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import type { BotOverview } from "@/lib/bot-overview-types";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { BOT_SECTIONS } from "./bot-settings/sections";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { OverviewSection } from "./bot-settings/OverviewSection";
import { IdentitySection } from "./bot-settings/IdentitySection";
import { SoulSection } from "./bot-settings/SoulSection";
import { SkillsSection } from "./bot-settings/SkillsSection";
import { MemorySection } from "./bot-settings/MemorySection";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { AccessSection } from "./bot-settings/AccessSection";
import { ModelSection } from "./bot-settings/ModelSection";
import { PermissionsSection } from "./bot-settings/PermissionsSection";
import { VoiceSection } from "./bot-settings/VoiceSection";
import { HistorySection, type HistoryRow } from "./bot-settings/HistorySection";
import { UsageSection } from "./bot-settings/UsageSection";
import type { PromptPreviewData } from "./bot-settings/PromptPreview";

function sectionMatches(entry: (typeof BOT_SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [entry.label, ...entry.keywords].some((part) => part.toLowerCase().includes(query));
}

export function BotSettingsDialog({ bot }: { bot: Bot }) {
  const { state, dispatch, flushBotPatches } = useStore();
  const section = state.botSettingsSection;
  const derived = useBotSettingsDerived(bot);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  // Keep expansion in the store too: header deep links can arrive while
  // this panel is already mounted, including after collapsing the same row.
  const collapsed = !state.botSettingsExpandAccordion;
  const q = query.trim().toLowerCase();
  const visibleSections = BOT_SECTIONS.filter((entry) => sectionMatches(entry, q));

  const [overview, setOverview] = useState<BotOverview | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [prompt, setPrompt] = useState<PromptPreviewData | null>(null);
  const [promptError, setPromptError] = useState(false);
  const [historyRows, setHistoryRows] = useState<HistoryRow[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [historyRevision, setHistoryRevision] = useState<string | null>(null);
  const historyRequest = useRef(0);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<{ id: string; expectedRevision: string } | null>(null);

  // The bot-record fields the server-built overview and system-prompt
  // preview actually read (OverviewFacts.bot plus the prompt's persona
  // inputs). A streamed message or unread flag replaces the bot object but
  // must not refetch an unchanged overview.
  const factsSignature = useMemo(
    () =>
      JSON.stringify([
        bot.name,
        bot.title,
        bot.description,
        bot.soul,
        bot.computer,
        bot.cloudBackend,
        bot.cwd,
        bot.autoApprove,
        bot.approvePeerComms,
        bot.peers,
        bot.section,
        bot.composio,
        bot.browser,
        bot.mcpServers,
        bot.chiefOfStaff,
        bot.managedSections,
        bot.modelSelection,
      ]),
    [
      bot.name,
      bot.title,
      bot.description,
      bot.soul,
      bot.computer,
      bot.cloudBackend,
      bot.cwd,
      bot.autoApprove,
      bot.approvePeerComms,
      bot.peers,
      bot.section,
      bot.composio,
      bot.browser,
      bot.mcpServers,
      bot.chiefOfStaff,
      bot.managedSections,
      bot.modelSelection,
    ],
  );

  // Fetch on entry: skills and memory are files, not bot-record fields, so
  // returning from either editor must reload their overview/prompt too.
  // Await the existing write queue instead of racing a second debounce.
  useEffect(() => {
    if (section !== "overview") return;
    let cancelled = false;
    const fetchOverviewAndPrompt = async () => {
      await flushBotPatches(bot.id);
      if (cancelled) return;
      void api(`/api/bots/${bot.id}/overview`)
        .then((data: BotOverview) => {
          if (cancelled) return;
          setOverview(data);
          setOverviewError(false);
        })
        .catch(() => {
          if (!cancelled) setOverviewError(true);
        });
      void api(`/api/bots/${bot.id}/system-prompt`)
        .then((data: PromptPreviewData) => {
          if (cancelled) return;
          setPrompt(data);
          setPromptError(false);
        })
        .catch(() => {
          if (!cancelled) setPromptError(true);
        });
    };

    void fetchOverviewAndPrompt();
    return () => {
      cancelled = true;
    };
  }, [bot.id, section, factsSignature, state.routines, state.webhooks, flushBotPatches]);

  // Read the file-backed history only when its section is opened. A newer
  // load (or leaving History) invalidates older rows, revision, and errors.
  const loadHistory = useCallback(() => {
    const request = ++historyRequest.current;
    setHistoryError(false);
    return flushBotPatches(bot.id)
      .then(() => api(`/api/bots/${bot.id}/history?limit=100`))
      .then((data: { rows: HistoryRow[]; revision: string }) => {
        if (request !== historyRequest.current) return;
        setHistoryRows(data.rows);
        setHistoryRevision(data.revision);
      })
      .catch(() => {
        if (request === historyRequest.current) setHistoryError(true);
      });
  }, [bot.id, flushBotPatches]);

  useEffect(() => {
    if (section !== "history") return;
    void loadHistory();
    return () => { historyRequest.current++; };
  }, [section, loadHistory]);

  // A rollback failure (the row's soul text no longer round-trips the
  // server's validation, say) still reloads history so the list matches
  // the server's actual state, but also surfaces the server's message
  // through the app's error toast — mirrors SoulField's Apply/Discard.
  const rollbackHistory = async (target: { id: string; expectedRevision: string }) => {
    if (rollingBack) return;
    setRollbackTarget(null);
    setRollingBack(true);
    try {
      await flushBotPatches(bot.id);
      await api(`/api/bots/${bot.id}/history/rollback`, {
        method: "POST",
        body: JSON.stringify(target),
      });
    } catch (e: unknown) {
        dispatch({ type: "error", message: e instanceof Error ? e.message : "Couldn't undo that change." });
    } finally {
      await loadHistory();
      setRollingBack(false);
    }
  };

  useEffect(() => {
    // Search narrows the collapsed row list. Choosing a row (or following
    // an external deep link) clears that filter so it cannot hide the body.
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
      // A dialog opened from inside this one (the routine editor, a skill
      // review, the model picker's popover, a computer warning) owns Escape
      // while it is up: Escape closes only that layer.
      // Only a *visible* nested dialog owns Escape. A hidden or
      // zero-size leftover (display:none, empty hit box) must not trap
      // the settings panel's own dismiss path.
      const nested = dialog?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length > 0) return;
      // BotInstructionsDialog portals to document.body, so it is not in this
      // subtree: a key pressed with focus outside this dialog belongs to
      // whatever holds focus, never to us.
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      if (event.key === "Escape") {
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
          // Data wins over a transient refetch failure: once an overview has
          // loaded once, a later failed refetch (routines/webhooks/bot-record
          // changed, the request errored) keeps showing it rather than
          // replacing a fully populated card with an error block — the same
          // precedence PromptPreview already gives its own data vs. error.
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
      case "skills":
        return <SkillsSection bot={bot} />;
      case "memory":
        // Memory has an explicit Save button; preserve its unsaved draft
        // while the user consults another section. It fetches when it
        // becomes the active section. Always mounted; visibility toggled
        // via hidden on the accordion body wrapper.
        return <MemorySection bot={bot} active={!collapsed && section === "memory"} />;
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
      case "history":
        return historyRows === null && historyError ? (
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">Couldn’t load history.</div>
        ) : (
          // Same precedence as the Overview: rows already on screen
          // survive a failed reload (after an undo, say) with a quiet
          // note rather than being replaced by an error block.
          <HistorySection
            bot={bot}
            rows={historyRows}
            refreshError={historyRows !== null && historyError}
            onRollback={(id) => {
              if (historyRevision) setRollbackTarget({ id, expectedRevision: historyRevision });
            }}
            rollingBack={rollingBack || !historyRevision}
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
        role="dialog"
        aria-labelledby="bot-settings-title"
        tabIndex={-1}
        className="animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel outline-none lg:static lg:z-auto lg:w-[min(420px,42vw)] lg:shrink-0"
      >
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
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

        <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-lg bg-control/70 px-2.5 py-2">
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
            placeholder="Search"
            aria-label="Search settings"
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {visibleSections.length === 0 && (
            <div className="px-4 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              Nothing matches “{query.trim()}”
            </div>
          )}
          {/* Walk all sections so Memory keeps a stable mount (draft survival)
              even when search filters its row out of view. Other unmatched
              rows are omitted entirely. */}
          {BOT_SECTIONS.map((entry) => {
            const { id, label, icon: Icon } = entry;
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
                {/* Memory stays mounted (hidden when collapsed) so drafts survive;
                    other sections only mount while expanded. */}
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
      </aside>
      <ConfirmDialog
        open={rollbackTarget !== null}
        title="Restore previous instructions?"
        body="Replaces current SOUL with the version before this change. Current version stays in History."
        confirmLabel="Restore instructions"
        tone="neutral"
        returnFocusRef={dialogRef}
        onCancel={() => setRollbackTarget(null)}
        onConfirm={() => { if (rollbackTarget) void rollbackHistory(rollbackTarget); }}
      />
    </>
  );
}
