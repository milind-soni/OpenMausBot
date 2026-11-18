// The conversations that are finished and already read, under the Inbox's active list, so a thread the person
// just read stays findable for a while instead of vanishing. Nothing here is stored: a thread qualifies while it is
// idle, has nothing unread and is not archived, and the ten most recent ones are shown.
import { CheckCircle2 } from "lucide-react";
import type { Bot, Group, Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import { attentionOwnerName, isOpenThread, openThreadRow, type AttentionThread, type OpenThread } from "../SidebarBotActivity";
import { formatUpdatedAt, threadRecency, threadUpdatedLabel } from "../SidebarThreadRow";

export const FINISHED_LIMIT = 10;

/** A finished conversation, a bot's or a room's, opened the way the Inbox's active list opens it. */
export type FinishedThread = AttentionThread;

/** A thread that never moved is an empty "New thread" unless it was opened from a message or was read. */
function everStarted(task: { createdAt?: number; updatedAt?: number; origin?: unknown; lastReadMessageId?: string }): boolean {
  return (task.updatedAt ?? 0) > (task.createdAt ?? 0) || task.origin !== undefined || task.lastReadMessageId !== undefined;
}

/** Finished, already-read conversations, newest first: idle, nothing unread, not archived, bot threads and rooms. */
export function finishedThreads(bots: readonly Bot[], groups: readonly Group[] = [], queued: Record<string, unknown[]> = {},
  limit = FINISHED_LIMIT, readThreads?: ReadonlySet<string>, exclude?: ReadonlySet<string>): FinishedThread[] {
  const found: Array<FinishedThread & { at: number }> = [];
  for (const bot of bots) {
    if (bot.hidden) continue;
    for (const task of bot.tasks ?? []) {
      if (exclude?.has(task.threadId)) continue;
      if ((task.unread && !readThreads?.has(task.threadId)) || task.busy || task.routineRunId || task.archivedAt) continue;
      if (!everStarted(task)) continue;
      if (task.activity === "working" || task.activity === "waiting-on-you" || task.waitingForTeammates === true) continue;
      if (queued[task.threadId]?.length) continue;
      found.push({ kind: "bot", botId: bot.id, botName: bot.name, task: { ...task, queued: false }, at: threadRecency(task) });
    }
  }
  for (const group of groups) {
    if (group.dm) continue;
    for (const task of group.tasks ?? []) {
      if (exclude?.has(task.threadId)) continue;
      const mainThread = task.threadId === group.threadId;
      const unread = task.unread ?? (mainThread && group.unread);
      if ((unread && !readThreads?.has(task.threadId)) || task.archivedAt) continue;
      if (roomThreadWorking(group, task.threadId)) continue;
      if (!everStarted({ ...task, lastReadMessageId: task.lastReadMessageId ?? (mainThread ? group.lastReadMessageId : undefined) })) continue;
      const speaker = roomThreadSpeakerId(group, task.threadId);
      const waiting = Boolean(speaker) && bots.find((bot) => bot.id === speaker)?.activity === "waiting-on-you";
      if (waiting || task.activity === "waiting-on-you") continue;
      if (queued[task.threadId]?.length) continue;
      found.push({ kind: "group", groupId: group.id, groupName: group.name, groupThreadId: group.threadId,
        task: { ...task, queued: false } as Task & { queued: boolean }, at: threadRecency(task) });
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, limit).map(({ at: _at, ...row }) => row);
}

export function FinishedThreads({ bots, groups, queued, readThreads, exclude, now, current, onOpen }: {
  bots: readonly Bot[];
  groups: readonly Group[];
  queued: Record<string, unknown[]>;
  /** Conversations the person has already read in the Inbox, even if the chat itself was never opened. */
  readThreads?: ReadonlySet<string>;
  /** Conversations the pinned section at the top already shows: this list leaves them out. */
  exclude?: ReadonlySet<string>;
  /** The clock the row's last-activity label is relative to. */
  now: number;
  /** The conversation the chat window has open, marked like a selected sidebar row. */
  current?: OpenThread;
  onOpen(row: FinishedThread): void;
}) {
  const rows = finishedThreads(bots, groups, queued, FINISHED_LIMIT, readThreads, exclude);
  if (!rows.length) return null;
  return (
    <section data-inbox-finished aria-label={t("inbox.settled.title")} className="border-t border-hairline/40 px-1.5 py-1.5">
      <div className="flex items-center gap-1 px-2 py-0.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-secondary">{t("inbox.settled.title")}</span>
      </div>
      {rows.map((row) => {
        const name = attentionOwnerName(row);
        const at = threadRecency(row.task);
        const label = t("attention.item", { title: row.task.title, name, status: t("inbox.settled.read") });
        const open = isOpenThread(row, current);
        return (
          <button key={`${row.kind}-${row.kind === "bot" ? row.botId : row.groupId}-${row.task.threadId}`} type="button" aria-label={label} title={label}
            aria-current={open ? "page" : undefined} data-open-thread={open || undefined} onClick={() => onOpen(row)}
            className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink hover:bg-menu-hover", open && openThreadRow)}>
            <CheckCircle2 size={16} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{row.task.title}</span>
              <span className="block truncate text-[11px] text-ink-secondary">
                {name} · {t("inbox.settled.read")} · <time data-finished-when dateTime={new Date(at).toISOString()} title={formatUpdatedAt(at)}>{threadUpdatedLabel(at, now)}</time>
              </span>
            </span>
          </button>
        );
      })}
    </section>
  );
}
