import { useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, UserRound } from "lucide-react";

import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { cn } from "@/lib/cn";
import { hiddenFromSidebar, useViewerEmail } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import { imeComposing } from "@/lib/send-key";
import { localizedTaskTitle } from "@/lib/task-title";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { useSelectThreadPane } from "./OpenPaneActions";
import { MENU_HEADING, MENU_ROW, MENU_SHEET, MENU_ITEM_SEPARATOR } from "./menu-recipe";
import { nextMenuIndex } from "./SidebarPopoverMenu";
import { ThreadSearch } from "./ThreadSearch";

type Entry = { owner: Bot; title: string; children?: never; onProfile?: never }
  | { owner: Bot; title?: never; children: ReactNode; onProfile: () => void };

function Choices({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const viewer = useViewerEmail();
  const selectPane = useSelectThreadPane();
  const [pickedBot, setPickedBot] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const bots = state.bots.filter(bot => !bot.hidden && !hiddenFromSidebar(bot, viewer));
  const browsingBots = Boolean(entry.onProfile) && !pickedBot;
  const owner = entry.onProfile ? bots.find(bot => bot.id === pickedBot) : entry.owner;
  const tasks = owner?.tasks?.length ? owner.tasks : owner ? [{ threadId: owner.threadId, title: owner.name }] : [];
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  const matches = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term));
  const shownBots = browsingBots ? bots.filter(bot => matches(bot.name)) : [];
  const shownTasks = tasks.filter(task => matches(localizedTaskTitle(task.title) + " " + task.title));
  const step = (id: string | null) => { setQuery(""); setPickedBot(id); };
  const choose = (threadId: string) => {
    if (!owner) return;
    onClose();
    if (selectPane(owner.id, threadId) || threadId === entry.owner.threadId) return;
    if (owner.threadId === threadId) dispatch({ type: "select", id: owner.id });
    else dispatch({ type: "switchTask", botId: owner.id, threadId, selectWhenReady: true });
  };
  const heading = browsingBots ? t("palette.bots") : t("task.namedList", { name: owner?.name ?? "" });
  return <div className="flex min-h-0 flex-col gap-1" onKeyDown={event => {
    if (imeComposing(event.nativeEvent)) return;
    if (event.key === "ArrowLeft" && pickedBot && !query) {
      event.preventDefault();
      step(null);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = nextMenuIndex(event.key, rows.findIndex(row => row === document.activeElement), rows.length);
    if (index !== null) { event.preventDefault(); rows[index].focus(); }
  }}>
    <div className="flex items-center gap-1">
      {pickedBot && <button type="button" aria-label={t("model.simple.back")} onClick={() => step(null)}
        className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-menu-hover">
        <ChevronLeft size={16} aria-hidden="true" className="rtl:-scale-x-100" />
      </button>}
      <span className={cn(MENU_HEADING, "truncate")}>{heading}</span>
    </div>
    <ThreadSearch key={pickedBot ?? "search"} query={query} setQuery={setQuery} onClose={onClose} escapeClears={false}
      label={browsingBots ? t("botAccess.overview.searchBots") : t("task.search")} onEnter={() => {
        if (browsingBots && shownBots[0]) step(shownBots[0].id);
        else if (shownTasks[0]) choose(shownTasks[0].threadId);
      }} />
    <div ref={list} className="min-h-0 overflow-y-auto" role="group" aria-label={heading}>
      {shownBots.map(bot => <button key={bot.id} type="button" aria-label={bot.name} className={MENU_ROW} onClick={() => step(bot.id)}>
        <BotAvatar bot={bot} size={24} state="happy" animated={false} />
        <span dir="auto" className="min-w-0 flex-1 truncate">{bot.name}</span>
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />
      </button>)}
      {shownTasks.map(task => {
        const current = task.threadId === entry.owner.threadId;
        const title = localizedTaskTitle(task.title || t("task.untitledChat"));
        return <button key={task.threadId} type="button" data-thread-choice={task.threadId} className={MENU_ROW}
          aria-current={current || undefined} title={title} onClick={() => choose(task.threadId)}>
          <Check size={14} aria-hidden="true" className={cn("shrink-0 text-accent", !current && "invisible")} />
          <span dir="auto" className="truncate">{title}</span>
        </button>;
      })}
      {!shownBots.length && !shownTasks.length && <p className="px-2 py-4 text-center text-[13px] text-ink-secondary">{t("task.noMatch", { query })}</p>}
    </div>
    {browsingBots && entry.onProfile && <>
      <div className={MENU_ITEM_SEPARATOR} role="separator" />
      <button type="button" className={MENU_ROW} onClick={() => { onClose(); entry.onProfile(); }}>
        <UserRound size={16} aria-hidden="true" />{t("chat.openProfileAria", { name: entry.owner.name })}
      </button>
    </>}
  </div>;
}

export function WorkspaceThreadPicker(entry: Entry) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    if (root.current?.contains(document.activeElement)) trigger.current?.focus();
  };
  usePopoverDismiss(open, root, close);
  const label = entry.onProfile ? t("palette.bots") + " · " + entry.owner.name : t("task.switch");
  return <div ref={root} className="min-w-0">
    <button ref={trigger} type="button" data-tour={entry.onProfile ? "bot-pill" : undefined} aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={entry.title ? entry.title + " · " + label : label} onClick={() => setOpen(!open)}
      className={cn("group flex h-9 max-w-full items-center gap-1 rounded-full px-2 text-[14px] text-ink-secondary hover:bg-ink/[0.06]",
        entry.onProfile && "h-auto gap-2 py-[5.5px] ps-[5.5px] text-ink")}>
      {entry.children ?? <>
        <span data-chathead-conversation dir="auto" className="max-w-[180px] truncate font-medium">{entry.title}</span>
        <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
      </>}
    </button>
    {open && <div id={id} role="dialog" aria-label={label}
      className={cn(MENU_SHEET, "absolute start-0 top-full z-40 mt-1 max-h-[min(24rem,65cqh)] w-80 max-w-[100cqw]")}>
      <Choices entry={entry} onClose={close} />
    </div>}
  </div>;
}
