import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Search } from "lucide-react";

import { cn } from "@/lib/cn";
import { llmThreadTitlesEnabled } from "@/lib/feature-flags";
import { activeLocale, t } from "@/lib/i18n";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { api, currentTaskBot, openBotThread, useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { lastLine } from "../sidebar-preview";
import { isArchived, orderedThreadList, SidebarThreadRow, stampClock, threadRecency, threadRowActions, useRelativeNow } from "../SidebarThreadRow";
import { filterTasks } from "../TaskPicker";
import { CardLabel } from "./rows";

export const CONVERSATIONS_SHOWN = 4;
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

/** Tests only. */
export function forgetConversationLines(): void {
  fetched.clear();
  asked.clear();
}

export function BotConversations({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const now = useRelativeNow();
  const phone = !useMediaQuery(SIDEBAR_INLINE, true);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const generatedTitles = llmThreadTitlesEnabled(state.config);
  const actions = useMemo(() => {
    const { onRename, onRegenerateTitle, onDelete, onMove, onPin } = threadRowActions(bot.id, dispatch, generatedTitles);
    return { onRename, onRegenerateTitle, onDelete, onMove, onPin };
  }, [bot.id, dispatch, generatedTitles]);

  const conversations = orderedThreadList((bot.tasks ?? [{ threadId: bot.threadId, title: t("task.newShort"), createdAt: 0 }])
    .filter((task) => !task.routineRunId && (!isArchived(task) || task.threadId === bot.threadId)))
    .map((task) => {
      const thread = currentTaskBot(bot, task.threadId);
      return {
        ...task, busy: thread.busy, activity: thread.activity, waitingForTeammates: thread.waitingForTeammates,
        turnStartedAt: thread.turnStartedAt ?? undefined, queued: Boolean(state.pendingQueued[task.threadId]?.length),
      };
    });
  const needle = query.trim();
  const collapsed = conversations.filter((task, index) => index < CONVERSATIONS_SHOWN || task.threadId === bot.threadId);
  const recent = useRecentMessages(bot, needle || expanded ? conversations : collapsed);
  const preview = (threadId: string) => {
    const messages = recent(threadId);
    return messages ? lastLine(currentTaskBot(bot, threadId), messages, state.instances, false) : undefined;
  };
  const byTitle = filterTasks(conversations, needle);
  const matches = needle
    ? [...byTitle, ...conversations.filter((task) => !byTitle.includes(task) && preview(task.threadId)?.toLowerCase().includes(needle.toLowerCase()))]
    : conversations;
  const shown = needle ? matches : expanded ? conversations : collapsed;
  const hidden = conversations.length - collapsed.length;
  const project = bot.projects?.find((folder) => folder.id === bot.tasks?.find((task) => task.threadId === bot.threadId)?.projectId);

  const closeOnPhone = () => {
    if (phone) dispatch({ type: "toggleSettings", open: false });
  };
  const select = (task: { threadId: string }) => {
    if (task.threadId !== bot.threadId) openBotThread(dispatch, bot, task.threadId, false);
    closeOnPhone();
  };
  const startNew = () => {
    dispatch({ type: "newTask", botId: bot.id, ...(project ? { projectId: project.id } : {}) });
    closeOnPhone();
  };
  const stopSearching = () => {
    setQuery("");
    setSearching(false);
  };

  return (
    <section data-panel-card="conversations" aria-labelledby="bot-panel-conversations">
      <CardLabel action={
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-conversations-search
            aria-label={t("botPanel.conversations.search")}
            title={t("botPanel.conversations.search")}
            aria-pressed={searching}
            onClick={() => (searching ? stopSearching() : setSearching(true))}
            className={cn("flex size-7 items-center justify-center rounded-full hover:bg-ink/[0.06] hover:text-ink", searching && "bg-ink/[0.06] text-ink")}
          >
            <Search size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-conversations-new
            aria-label={t("botPanel.conversations.new")}
            title={t("botPanel.conversations.new")}
            onClick={startNew}
            className="flex size-7 items-center justify-center rounded-full hover:bg-ink/[0.06] hover:text-ink"
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </span>
      }>
        <span id="bot-panel-conversations">{t("botPanel.conversations.title")}</span>
      </CardLabel>
      {searching && (
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
          className="mb-1.5 w-full rounded-[10px] border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-focus"
        />
      )}
      <div role="list" aria-labelledby="bot-panel-conversations" className="flex flex-col gap-px">
        {shown.map((task) => (
          <div role="listitem" key={task.threadId} data-conversation={task.threadId}>
            <SidebarThreadRow
              panel
              preview={preview(task.threadId)}
              task={task}
              ownerId={bot.id}
              current={task.threadId === bot.threadId}
              folders={bot.projects}
              now={stampClock(threadRecency(task), now)}
              locale={activeLocale()}
              onSelect={select}
              {...actions}
            />
          </div>
        ))}
      </div>
      {needle && shown.length === 0 && (
        <p className="px-3 py-3 text-[12.5px] text-ink-secondary">{t("task.noMatch", { query: needle })}</p>
      )}
      {!needle && hidden > 0 && (
        <button
          type="button"
          data-conversations-more
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink"
        >
          {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          {expanded ? t("botPanel.conversations.showFewer") : t("botPanel.conversations.showMore", { count: hidden })}
        </button>
      )}
    </section>
  );
}
