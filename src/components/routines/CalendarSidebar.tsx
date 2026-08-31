import { useMemo, useState, type DragEvent } from "react";
import { GripVertical, Plus, Search, UsersRound } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import type { Bot } from "@/state/store";
import { MiniMonth } from "./MiniMonth";

export const BOT_CALENDAR_DRAG_TYPE = "application/x-openmaus-bot";

export interface CalendarSidebarProps {
  bots: Bot[];
  anchor: number;
  onSelectDate: (at: number) => void;
  onCreate: () => void;
}

export function CalendarSidebar({ bots, anchor, onSelectDate, onCreate }: CalendarSidebarProps) {
  const [query, setQuery] = useState("");
  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return bots;
    return bots.filter((bot) =>
      `${bot.name} ${bot.title} ${bot.description}`.toLocaleLowerCase().includes(normalized),
    );
  }, [bots, query]);

  const beginBotDrag = (event: DragEvent<HTMLDivElement>, bot: Bot) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(BOT_CALENDAR_DRAG_TYPE, bot.id);
    event.dataTransfer.setData("text/plain", bot.id);
  };

  return (
    <aside
      aria-label="Calendar sidebar"
      className="flex h-full w-[320px] shrink-0 flex-col overflow-hidden border-r border-hairline/40 bg-panel"
    >
      <div className="px-4 pb-2 pt-4">
        <button
          type="button"
          onClick={onCreate}
          className="group flex h-11 w-full items-center justify-center gap-2 rounded-full bg-accent px-5 text-[13px] font-semibold text-white shadow-lg shadow-accent/15 transition hover:-translate-y-px hover:brightness-110 hover:shadow-xl hover:shadow-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:translate-y-0"
        >
          <Plus size={17} strokeWidth={2.5} aria-hidden="true" />
          Create
        </button>
      </div>

      <MiniMonth anchor={anchor} onSelect={onSelectDate} />

      <div className="mx-4 border-t border-hairline/40" />

      <section aria-labelledby="calendar-bots-heading" className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <div id="calendar-bots-heading" className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.11em] text-ink-secondary">
            <UsersRound size={13} aria-hidden="true" />
            My bots
          </div>
          <span className="rounded-full bg-raised px-1.5 py-0.5 text-[9px] tabular-nums text-ink-secondary">
            {bots.length}
          </span>
        </div>

        <label className="relative mb-2 block">
          <span className="sr-only">Search bots</span>
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-secondary/70"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            placeholder="Search bots"
            className="h-8 w-full rounded-lg border border-hairline/45 bg-control/55 pl-8 pr-2.5 text-[11.5px] text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent/60 focus:bg-control"
          />
        </label>

        <div role="list" aria-label="Bots available to schedule" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
          {filteredBots.map((bot) => (
            <div
              key={bot.id}
              draggable
              onDragStart={(event) => beginBotDrag(event, bot)}
              role="listitem"
              className="group flex cursor-grab items-center gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-raised/80 active:cursor-grabbing"
              aria-label={`Drag ${bot.name} onto the calendar`}
              title={`Drag ${bot.name} onto a time slot`}
            >
              <GripVertical
                size={13}
                className="shrink-0 text-ink-secondary/35 transition-colors group-hover:text-ink-secondary"
                aria-hidden="true"
              />
              <BotAvatar bot={bot} size={27} animated={false} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] font-medium text-ink">{bot.name}</div>
                <div className="truncate text-[9.5px] text-ink-secondary/75">
                  {bot.title || "BotAgent"}
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-hairline/50 px-1.5 py-0.5 text-[8.5px] text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100">
                Drag
              </span>
            </div>
          ))}

          {filteredBots.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] leading-relaxed text-ink-secondary">
              {bots.length === 0 ? "Create a bot to schedule work." : "No bots match your search."}
            </div>
          )}
        </div>

        <p className="mt-2 px-2 text-[9.5px] leading-relaxed text-ink-secondary/65">
          Drag a bot onto any time to schedule it.
        </p>
      </section>
    </aside>
  );
}
