import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, MessageSquare, Search, Settings, Users } from "lucide-react";
import { intlLocale, t } from "@/lib/i18n";
import { COMMAND_PALETTE_OPEN_EVENT } from "@/lib/command-palette";
import { cn } from "@/lib/cn";
import { api, openBot, openRoomThread, openThread, useStore, visibleMessages } from "@/state/store";
import { rankByName } from "@/lib/palette-rank";
import { useShowThreads } from "@/lib/thread-preferences";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";
import { imeComposing } from "@/lib/send-key";
import { localizedRelativeTime } from "@/lib/relative-time";
import { useAdvancedMode } from "@/lib/interface-mode";
import { BotAvatar } from "./Avatar";
import { botPreview } from "./sidebar-preview";
import { openSettingsSearchHit } from "./settings/settings-search-navigation";
import { useSettingsContext } from "./settings/settings-context";
import { searchSettings } from "./settings/settings-index";

export { openCommandPalette } from "@/lib/command-palette";

type Entry = { id: string; icon: ReactNode; title: ReactNode; detail?: string; run: () => void };

export function CommandPalette({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const advanced = useAdvancedMode();
  const settingsContext = useSettingsContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const [cursor, setCursor] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const q = query.trim().toLowerCase();
  const loading = Boolean(q && results?.query !== q);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey || imeComposing(event)) return;
      event.preventDefault();
      setOpen((wasOpen) => !wasOpen);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      setQuery("");
      setResults(null);
      setCursor(0);
      element.showModal();
      inputRef.current?.focus();
    } else if (element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => onOpenChange?.(open), [onOpenChange, open]);

  useEffect(() => {
    if (!open || !q) return;
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
        .then((result: { hits?: SearchHit[] }) => { if (alive) setResults({ query: q, hits: result.hits ?? [] }); })
        .catch(() => { if (alive) setResults({ query: q, hits: [] }); });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q]);

  useEffect(() => {
    if (open) selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, cursor, results]);

  const avatar = (bot: Parameters<typeof BotAvatar>[0]["bot"]) => <BotAvatar bot={bot} state="happy" size={28} animated={false} />;
  const bots = state.bots.filter((bot) => !bot.hidden);
  const matchingBots = rankByName(bots, q);
  const settings = searchSettings(q, settingsContext, (entry) => t(entry.labelKey), (page) => t(page.labelKey))
    .filter((hit) => !hit.elsewhere && (hit.entry.jump !== "bot" || bots.some((bot) => bot.id === state.selectedId)))
    .slice(0, 6);
  const matchingRooms = rankByName(state.groups, q);
  const rooms: Entry[] = matchingRooms.map((group) => ({
    id: `room:${group.id}`, icon: <Users size={20} />, title: group.name,
    run: () => dispatch({ type: "select", id: group.id }),
  }));

  const sections: { heading: string; entries: Entry[] }[] = [
    {
      heading: t("palette.bots"),
      entries: matchingBots.map((bot) => ({
        id: `bot:${bot.id}`, icon: avatar(bot), title: bot.name,
        detail: botPreview(bot, visibleMessages(bot), state.instances, advanced) || bot.title,
        run: () => openBot(dispatch, bot, showThreads),
      })),
    },
    { heading: t("palette.groups"), entries: rooms },
    {
      heading: t("palette.threads"),
      entries: q ? [
        ...bots.flatMap((bot) => (bot.tasks ?? [])
          .filter((task) => !task.routineRunId && (task.title.toLowerCase().includes(q) ||
            bot.projects?.some((project) => project.id === task.projectId && project.name.toLowerCase().includes(q))))
          .map((task): Entry => ({
            id: `bot-thread:${bot.id}:${task.threadId}`, icon: avatar(bot), title: task.title, detail: bot.name,
            run: () => openThread(dispatch, { botId: bot.id, threadId: task.threadId }, state, showThreads),
          }))),
        ...state.groups.flatMap((group) => (group.tasks ?? [])
          .filter((task) => task.title.toLowerCase().includes(q))
          .map((task): Entry => ({
            id: `room-thread:${group.id}:${task.threadId}`, icon: <Users size={20} />, title: task.title, detail: group.name,
            run: () => openRoomThread(dispatch, { groupId: group.id, threadId: task.threadId }, state.groups),
          }))),
      ].slice(0, 12) : [],
    },
    {
      heading: t("palette.actions"),
      entries: [
        ...(t("settings.title").toLowerCase().includes(q) ? [{
          id: "settings", icon: <Settings size={20} />, title: t("settings.title"),
          run: () => dispatch({ type: "toggleAppSettings", open: true }),
        }] : []),
        ...settings.map((hit): Entry => ({
          id: `setting:${hit.entry.id}`, icon: <Settings size={20} />, title: t(hit.entry.labelKey),
          run: () => openSettingsSearchHit(hit, settingsContext, dispatch),
        })),
      ],
    },
    {
      heading: t("palette.messages"),
      entries: q && results?.query === q ? results.hits.map((hit) => {
        const bot = bots.find((candidate) => candidate.id === hit.botId);
        const end = hit.matchStart + hit.matchLength;
        return {
          id: `msg:${hit.threadId}:${hit.messageId}`, icon: bot ? avatar(bot) : <MessageSquare size={20} />,
          title: <>{hit.snippet.slice(0, hit.matchStart)}<strong>{hit.snippet.slice(hit.matchStart, end)}</strong>{hit.snippet.slice(end)}</>,
          detail: [hit.name, hit.task, localizedRelativeTime(hit.at, intlLocale())].filter(Boolean).join(" · "),
          run: () => {
            void landOnSearchHit(hit, state, dispatch, showThreads).catch((error: unknown) => {
              dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
            });
          },
        };
      }) : [],
    },
  ];

  const entries = sections.flatMap((section) => section.entries);
  const selected = Math.max(0, Math.min(cursor, entries.length - 1));
  const activate = (entry: Entry | undefined) => {
    if (!entry) return;
    setOpen(false);
    entry.run();
  };
  const modifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

  return (
    <dialog
      ref={dialog}
      data-command-palette
      data-look="dialog"
      role="dialog"
      aria-label={t("palette.label")}
      className="command-palette ui-modal fixed m-auto w-[calc(100%-2rem)] max-w-[640px] overflow-hidden rounded-2xl border border-hairline/50 bg-menu text-ink"
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      onKeyDown={(event) => {
        if (imeComposing(event.nativeEvent)) { event.stopPropagation(); return; }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") return;
        event.stopPropagation();
        if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
          const entry = entries[Number(event.key) - 1];
          if (entry) { event.preventDefault(); activate(entry); }
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (entries.length) setCursor((selected + (event.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length);
        } else if (event.key === "Enter") {
          event.preventDefault();
          activate(entries[selected]);
        }
      }}
    >
      <div className="flex max-h-[min(36rem,85dvh)] flex-col">
        <div className="flex items-center gap-4 px-5 py-4">
          {loading
            ? <Loader2 size={19} className="shrink-0 text-ink-tertiary motion-safe:animate-spin" aria-hidden />
            : <Search size={19} className="shrink-0 text-ink-tertiary" aria-hidden />}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              if (next.trim().toLowerCase() !== q) setResults(null);
              setQuery(next);
              setCursor(0);
            }}
            aria-busy={loading}
            aria-label={t("commandPalette.searchLabel")}
            placeholder={t("commandPalette.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[22px] placeholder:text-ink-tertiary focus:outline-none"
          />
        </div>
        <div className="min-h-0 overflow-y-auto px-2.5 pb-2.5">
          {!loading && entries.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-ink-secondary">{q ? t("sidebar.noMatch", { query }) : t("palette.empty")}</p>
          )}
          {sections.map(({ heading, entries: rows }) => rows.length > 0 && (
            <section key={heading} aria-label={heading} className="pt-2">
              <div className="px-3 pb-2 text-[12px] text-ink-tertiary">{heading}</div>
              {rows.map((entry) => {
                const index = entries.indexOf(entry);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    ref={index === selected ? selectedRef : undefined}
                    onClick={() => activate(entry)}
                    onMouseMove={() => setCursor(index)}
                    onFocus={() => setCursor(index)}
                    className={cn("flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus", index === selected && "bg-menu-active")}
                  >
                    <span className="grid size-8 shrink-0 place-items-center text-ink-secondary">{entry.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span dir="auto" className="block truncate text-[14px]">{entry.title}</span>
                      {entry.detail && <span dir="auto" className="block truncate text-[13px] text-ink-secondary">{entry.detail}</span>}
                    </span>
                    {index < 9 && <kbd aria-hidden className="shrink-0 rounded border border-hairline/40 bg-raised px-1 text-[11px] text-ink-secondary">{modifier}{index + 1}</kbd>}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}
