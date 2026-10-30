import { useEffect, useRef, useState } from "react";
import { Bot as BotIcon, MessageSquare, Search, Users } from "lucide-react";
import { api, openBot, useStore, type Bot, type Group } from "@/state/store";
import { t } from "@/lib/i18n";
import { rankByName } from "@/lib/palette-rank";
import { useShowThreads } from "@/lib/thread-preferences";
import { cn } from "@/lib/cn";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";

type PaletteEntry =
  | { kind: "bot"; bot: Bot }
  | { kind: "room"; group: Group }
  | { kind: "message"; hit: SearchHit };

const OPEN_EVENT = "omb:open-command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandPalette({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setMessageHits([]);
    setCursor(0);
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!open || !q) {
      setMessageHits([]);
      return;
    }
    setMessageHits([]);
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
        .then((result: { hits?: SearchHit[] }) => alive && setMessageHits(result.hits ?? []))
        .catch(() => alive && setMessageHits([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q]);

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, messageHits]);

  if (!open) return null;

  const bots = rankByName(state.bots.filter((b) => !b.hidden), q);
  const rooms = rankByName(state.groups, q);
  const entries: PaletteEntry[] = [
    ...bots.map((bot): PaletteEntry => ({ kind: "bot", bot })),
    ...rooms.map((group): PaletteEntry => ({ kind: "room", group })),
    ...(q ? messageHits.map((hit): PaletteEntry => ({ kind: "message", hit })) : []),
  ];
  const selected = entries.length ? Math.min(cursor, entries.length - 1) : 0;

  const activate = async (entry: PaletteEntry) => {
    if (entry.kind === "message") {
      const hit = entry.hit;
      try {
        await landOnSearchHit(hit, state, dispatch, showThreads);
      } catch (error) {
        dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } else if (entry.kind === "bot") {
      openBot(dispatch, entry.bot, showThreads);
    } else {
      dispatch({ type: "select", id: entry.group.id });
    }
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(entries.length ? (selected + 1) % entries.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(entries.length ? (selected - 1 + entries.length) % entries.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void activate(entry);
    }
  };

  const roomOffset = bots.length;
  const messageOffset = bots.length + rooms.length;

  const row = (key: string, index: number, onPick: () => void, children: React.ReactNode, twoLine = false) => (
    <button
      key={key}
      ref={index === selected ? selectedRef : undefined}
      onClick={onPick}
      // mousemove, not mouseenter: rows shifting under a resting pointer must not steal the keyboard selection.
      onMouseMove={() => setCursor(index)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left",
        twoLine && "flex-col items-stretch gap-0.5",
        index === selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      {children}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 pt-[14vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="popover-surface flex max-h-[min(480px,70vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("commandPalette.searchLabel")}
            placeholder={t("commandPalette.searchPlaceholder")}
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <kbd className="shrink-0 rounded-md border border-hairline/40 px-1.5 py-0.5 text-[11px] text-ink-secondary">
            esc
          </kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {entries.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
              {q ? `Nothing matches “${query}”` : "Nothing to switch to yet"}
            </div>
          )}
          {bots.length > 0 && (
            <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Bots
            </div>
          )}
          {bots.map((bot, i) =>
            row(
              `bot:${bot.id}`,
              i,
              () => void activate({ kind: "bot", bot }),
              <>
                <BotIcon size={16} className="shrink-0 text-ink-secondary" />
                <span className="truncate text-[14px] text-ink">{bot.name}</span>
                {bot.title && (
                  <span className="min-w-0 truncate text-[13px] text-ink-secondary">{bot.title}</span>
                )}
              </>,
            ),
          )}
          {rooms.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Groups
            </div>
          )}
          {rooms.map((group, i) =>
            row(
              `room:${group.id}`,
              roomOffset + i,
              () => void activate({ kind: "room", group }),
              <>
                <Users size={16} className="shrink-0 text-ink-secondary" />
                <span className="truncate text-[14px] text-ink">{group.name}</span>
              </>,
            ),
          )}
          {q && messageHits.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Messages
            </div>
          )}
          {q &&
            messageHits.map((hit, i) => {
              const before = hit.snippet.slice(0, hit.matchStart);
              const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
              const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
              return row(
                `msg:${hit.threadId}:${hit.messageId}`,
                messageOffset + i,
                () => void activate({ kind: "message", hit }),
                <>
                  <span className="flex items-center gap-2 truncate text-[13px] font-medium text-ink">
                    <MessageSquare size={13} className="shrink-0 text-ink-secondary" />
                    {hit.name}
                    {hit.task ? <span className="font-normal text-ink-secondary"> · {hit.task}</span> : null}
                  </span>
                  <span className="line-clamp-2 text-[13px] text-ink-secondary">
                    {before}<mark className="rounded-sm bg-accent/25 px-0.5 text-ink">{match}</mark>{after}
                  </span>
                </>,
                true,
              );
            })}
        </div>
      </div>
    </div>
  );
}
