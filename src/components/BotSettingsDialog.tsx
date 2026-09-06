// Per-bot settings, as a centered dialog with the same section-rail shell
// as the app SettingsModal — replaces the old right-hand SettingsPanel
// aside. Every section now lives under bot-settings/; this dialog owns
// only the fetches (overview, system-prompt, history) and the section
// switch.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
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
        bot.chiefOfStaff,
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
      bot.chiefOfStaff,
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
    const visible = BOT_SECTIONS.filter((entry) => sectionMatches(entry, q));
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch({ type: "toggleSettings", open: true, section: first.id });
  }, [dispatch, q, section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      // A dialog opened from inside this one (the routine editor, a skill
      // review, the model picker's popover, a computer warning) owns Escape
      // and Tab while it is up: Escape closes only that layer, and the focus
      // trap below must not pull focus back out of it.
      if (dialog?.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      // BotInstructionsDialog portals to document.body, so it is not in this
      // subtree: a key pressed with focus outside this dialog belongs to
      // whatever holds focus, never to us.
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === dialog || active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-settings-title"
        tabIndex={-1}
        className="flex h-[min(640px,calc(100vh-3rem))] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          {/* shrink-0 on the two fixed rows: the title has overflow hidden
              (truncate), which lets a flex column shrink it to absorb an
              overflowing section list — the name's top got clipped. The
              list below scrolls instead. */}
          <div id="bot-settings-title" className="shrink-0 truncate px-2 py-3 text-[15px] font-semibold text-ink">
            {bot.name}
          </div>
          <div className="mb-2 mt-1 flex shrink-0 items-center gap-2 rounded-lg bg-control/70 px-2.5 py-2">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {visibleSections.length === 0 && (
              <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
                Nothing matches “{query.trim()}”
              </div>
            )}
            {visibleSections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => dispatch({ type: "toggleSettings", open: true, section: id })}
                aria-current={section === id ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                  section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                )}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {BOT_SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleSettings", open: false })}
              aria-label="Close settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "overview" &&
              (overview === null && overviewError ? (
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
                />
              ))}

            {section === "identity" && (
              <IdentitySection
                bot={bot}
                patch={derived.patch}
                activeState={derived.activeState}
                mascotMotion={derived.mascotMotion}
              />
            )}

            {section === "soul" && <SoulSection bot={bot} patch={derived.patch} />}

            {section === "skills" && <SkillsSection bot={bot} />}

            {/* Memory has an explicit Save button; preserve its unsaved draft
                while the user consults another section. It fetches on expand. */}
            <div hidden={section !== "memory"}><MemorySection bot={bot} /></div>

            {section === "routines" && (
              <RoutinesSection bot={bot} routines={derived.botRoutines} runs={state.routineRuns} />
            )}

            {section === "access" && <AccessSection bot={bot} derived={derived} />}

            {section === "model" && <ModelSection bot={bot} derived={derived} />}

            {section === "permissions" && <PermissionsSection bot={bot} derived={derived} />}

            {section === "voice" && <VoiceSection bot={bot} derived={derived} />}

            {section === "history" &&
              (historyRows === null && historyError ? (
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
              ))}

            {section === "usage" && <UsageSection bot={bot} />}
          </div>
        </div>
      </div>
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
    </div>
  );
}
