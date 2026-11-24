import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, SquarePen } from "lucide-react";

import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { api, currentTaskBot, openBotThread, visibleMessages, type Bot, type Message } from "@/state/store";
import { lastLine } from "../sidebar-preview";
import { isArchived, mainThreadFirst, orderedThreadList, SidebarThreadRow, stampClock, threadRecency, threadRowActions, useRelativeNow } from "../SidebarThreadRow";
import { filterTasks } from "../TaskPicker";
import { useConversationSide } from "../TeamSideSwitch";
import { tasksOfSide } from "@/state/team-side";
import { CardLabel, panelActionCls } from "./rows";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-select";

export const CONVERSATIONS_SHOWN = 3;
const PANEL_ROW_LOOK = "[&_.font-semibold]:font-medium [&_time]:text-[12px] [&_time]:text-ink-tertiary [&_span.bg-accent]:size-2";
const LAST_LINE_PAGE = 8;
const MAX_CACHED = 200;

type Page = { messages?: Message[]; activeLeafId?: string | null };
const fetched = new Map<string, Message[]>();
const asked = new Set<string>();

const lineKey = (task: { threadId: string; updatedAt?: number; createdAt?: number }) => `${task.threadId}@${threadRecency(task)}`;

/** Each listed conversation's newest messages: the open one from the chat, the rest fetched once per change. */
function useRecentMessages(bot: Bot, threads: readonly { threadId: string; updatedAt?: number; createdAt?: number }[]): (threadId: string) => Message[] | undefined {
  const [, settle] = useState(0);
  const wanted = threads.filter((task) => task.threadId !== bot.threadId).map(lineKey);
  const missing = wanted.filter((key) => !fetched.has(key) && !asked.has(key)).join(",");
  useEffect(() => {
    if (!missing) return;
    for (const key of missing.split(",")) {
      asked.add(key);
      const threadId = key.slice(0, key.lastIndexOf("@"));
      void api<Page>(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=${LAST_LINE_PAGE}`, { background: true })
        .then((page) => {
          fetched.set(key, visibleMessages({ messages: page.messages ?? [], activeLeafId: page.activeLeafId ?? undefined }));
          if (fetched.size > MAX_CACHED) fetched.delete(fetched.keys().next().value!);
          settle((count) => count + 1);
        })
        .catch(() => {})
        .finally(() => asked.delete(key));
    }
  }, [missing]);
  const open = visibleMessages(bot);
  const byThread = new Map(threads.map((task) => [task.threadId, lineKey(task)]));
  return (threadId) => threadId === bot.threadId ? open : fetched.get(byThread.get(threadId) ?? "");
}

/** The sidebar's "N more" opens this list with every conversation showing, whether or not the panel is already open. */
let showAllNext: string | null = null;
const showAllListeners = new Set<(botId: string) => void>();
export function showAllConversations(botId: string): void {
  showAllNext = botId;
  for (const listener of showAllListeners) listener(botId);
}

/** Tests only. */
export function forgetConversationLines(): void {
  fetched.clear();
  asked.clear();
}

export function BotConversations({ bot }: { bot: Bot }) {
  const state = useStoreSelector((s) => ({ instances: s.instances, pendingQueued: s.pendingQueued }), sameFields), dispatch = useStoreDispatch();
  const now = useRelativeNow();
  const phone = !useMediaQuery(SIDEBAR_INLINE, true);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    const asked = showAllNext === bot.id;
    if (asked) showAllNext = null;
    return asked;
  });
  useEffect(() => {
    const listener = (botId: string) => { if (botId !== bot.id) return; showAllNext = null; setExpanded(true); };
    showAllListeners.add(listener);
    return () => { showAllListeners.delete(listener); };
  }, [bot.id]);
  const [showArchived, setShowArchived] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const actions = useMemo(() => {
    const { onRename, onRegenerateTitle, onDelete, onMove, onPin, onSetMain, onArchive, onMemory } = threadRowActions(bot.id, dispatch);
    return { onRename, onRegenerateTitle, onDelete, onMove, onPin, onSetMain, onArchive, onMemory };
  }, [bot.id, dispatch]);

  const side = useConversationSide(bot);
  const tasks = bot.tasks ?? [{ threadId: bot.threadId, title: t("task.newShort"), createdAt: 0 }];
  const threads = (side ? tasksOfSide({ ...bot, tasks }, side) : tasks)
    .filter((task) => !task.routineRunId)
    .map((task) => {
      const thread = currentTaskBot(bot, task.threadId);
      return {
        ...task, busy: thread.busy, activity: thread.activity, waitingForTeammates: thread.waitingForTeammates,
        turnStartedAt: thread.turnStartedAt ?? undefined, queued: Boolean(state.pendingQueued[task.threadId]?.length),
      };
    });
  const kept = (task: (typeof threads)[number]) => task.threadId === bot.threadId || task.threadId === bot.mainThreadId;
  const conversations = mainThreadFirst(orderedThreadList(threads.filter((task) => kept(task) || (!isArchived(task) && !task.closedBy))), bot.mainThreadId);
  const ended = orderedThreadList(threads.filter((task) => !kept(task) && !isArchived(task) && Boolean(task.closedBy)));
  const archived = orderedThreadList(threads.filter((task) => isArchived(task) && !kept(task)));
  const needle = query.trim();
  const collapsed = conversations.filter((task, index) => index < CONVERSATIONS_SHOWN || task.threadId === bot.threadId || task.threadId === bot.mainThreadId);
  const recent = useRecentMessages(bot, [...(needle || expanded ? conversations : collapsed), ...(needle || showEnded ? ended : []), ...(showArchived ? archived : [])]);
  const preview = (threadId: string) => {
    const messages = recent(threadId);
    return messages ? lastLine(currentTaskBot(bot, threadId), messages, state.instances, false) : undefined;
  };
  const searched = [...conversations, ...ended];
  const byTitle = filterTasks(searched, needle);
  const matches = needle
    ? [...byTitle, ...searched.filter((task) => !byTitle.includes(task) && preview(task.threadId)?.toLowerCase().includes(needle.toLowerCase()))]
    : conversations;
  const shown = needle ? matches : expanded ? conversations : collapsed;
  const hidden = conversations.length - collapsed.length;
  const project = bot.projects?.find((folder) => folder.id === bot.tasks?.find((task) => task.threadId === bot.threadId)?.projectId);

  const latest = useRef({ bot, phone });
  latest.current = { bot, phone };
  const closeOnPhone = useCallback(() => {
    if (latest.current.phone) dispatch({ type: "toggleSettings", open: false });
  }, [dispatch]);
  const select = useCallback((task: { threadId: string }) => {
    const current = latest.current.bot;
    if (task.threadId !== current.threadId) openBotThread(dispatch, current, task.threadId, false);
    closeOnPhone();
  }, [dispatch, closeOnPhone]);
  const startNew = () => {
    dispatch({ type: "newTask", botId: bot.id, ...(project ? { projectId: project.id } : {}) });
    closeOnPhone();
  };
  const stopSearching = () => {
    setQuery("");
    setSearching(false);
  };

  // An open search stays up even if archiving leaves one conversation, so it can still be cleared.
  // An archived open conversation stays listed too, so it is not hidden while it is open.
  const listed = conversations.length >= 2 || searching || conversations.some((task) => task.threadId === bot.threadId && isArchived(task));
  const row = (task: (typeof threads)[number]) => (
    <div role="listitem" key={task.threadId} data-conversation={task.threadId}>
      <SidebarThreadRow panel preview={preview(task.threadId)} task={task} ownerId={bot.id} current={task.threadId === bot.threadId}
        main={task.threadId === bot.mainThreadId} folders={bot.projects} now={stampClock(threadRecency(task), now)} locale={activeLocale()} onSelect={select} {...actions} />
    </div>
  );

  return (
    <section data-panel-card="conversations" aria-label={t("botPanel.conversations.title")}>
      <CardLabel action={listed && (
        <button
          type="button"
          data-conversations-search
          aria-label={t("botPanel.conversations.search")}
          title={t("botPanel.conversations.search")}
          aria-pressed={searching}
          onClick={() => (searching ? stopSearching() : setSearching(true))}
          className={cn("-me-1 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink", searching && "bg-ink/[0.06] text-ink")}
        >
          <Search size={14} aria-hidden="true" />
        </button>
      )}>{t("botPanel.conversations.title")}</CardLabel>
      <div className={cn("flex items-center gap-2", listed && "mb-2")}>
        {bot.yourAccess !== "view" && side !== "team" && (
          <button
            type="button"
            data-conversations-new
            aria-label={t("botPanel.conversations.new")}
            onClick={startNew}
            className={cn(panelActionCls, "flex-1")}
          >
            <SquarePen size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
            <span className="truncate">{t("botPanel.conversations.new")}</span>
          </button>
        )}
      </div>
      {listed && searching && (
        <input
          autoFocus
          type="search"
          data-conversations-query
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            stopSearching();
          }}
          placeholder={t("botPanel.conversations.searchPlaceholder", { name: bot.name })}
          aria-label={t("botPanel.conversations.searchPlaceholder", { name: bot.name })}
          className="mb-1.5 w-full rounded-[8px] border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-focus"
        />
      )}
      {listed && <div role="list" aria-label={t("botPanel.conversations.title")} className={cn("flex flex-col gap-px", PANEL_ROW_LOOK)}>
        {shown.map(row)}
      </div>}
      {listed && needle && shown.length === 0 && (
        <p className="px-3 py-3 text-[13px] text-ink-secondary">{t("task.noMatch", { query: needle })}</p>
      )}
      {listed && !needle && hidden > 0 && (
        <button
          type="button"
          data-conversations-more
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink"
        >
          {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          {expanded ? t("botPanel.conversations.showFewer") : t("botPanel.conversations.showMore", { count: hidden })}
        </button>
      )}
      {!needle && ended.length > 0 && (
        <button
          type="button"
          data-conversations-ended
          aria-expanded={showEnded}
          onClick={() => setShowEnded((open) => !open)}
          className="mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink"
        >
          {showEnded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          {t("task.endedList", { count: ended.length })}
        </button>
      )}
      {!needle && showEnded && ended.length > 0 && (
        <div role="list" aria-label={t("task.endedList", { count: ended.length })} className={cn("flex flex-col gap-px", PANEL_ROW_LOOK)}>
          {ended.map(row)}
        </div>
      )}
      {!needle && archived.length > 0 && (
        <button
          type="button"
          data-conversations-archived
          aria-expanded={showArchived}
          onClick={() => setShowArchived((open) => !open)}
          className="mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink"
        >
          {showArchived ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          {t("task.archivedList", { count: archived.length })}
        </button>
      )}
      {!needle && showArchived && archived.length > 0 && (
        <div role="list" aria-label={t("task.archivedList", { count: archived.length })} className={cn("flex flex-col gap-px", PANEL_ROW_LOOK)}>
          {archived.map(row)}
        </div>
      )}
    </section>
  );
}
