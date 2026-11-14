import { X } from "lucide-react";
import type { ReactNode } from "react";

import { shownPersonName } from "../../shared/bot-owner";
import type { ResolvedSender } from "../../shared/wire";
import { useReactor } from "@/lib/cloud-guest";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";

type Waiting = { queueId: string; text: string; sender?: ResolvedSender };

/** The working line's lead in a conversation several people write in: whose request runs. */
export function workingForLabel(askedBy: ResolvedSender | undefined, viewer: string): string | undefined {
  if (!askedBy) return undefined;
  return askedBy.id === viewer ? t("chat.queue.workingForYou") : t("chat.queue.workingFor", { name: shownPersonName(askedBy.name) });
}

/** "Next: Tom's request, then 2 more", or null when nothing waits. */
export function nextLine(waiting: readonly Waiting[], viewer: string): string | null {
  const [head] = waiting;
  if (!head) return null;
  const mine = head.sender?.id === viewer;
  const name = shownPersonName(head.sender?.name ?? "");
  const more = waiting.length - 1;
  if (more > 0) return mine ? t("chat.queue.nextYoursMore", { count: more }) : t("chat.queue.nextMore", { name, count: more });
  return mine ? t("chat.queue.nextYours") : t("chat.queue.next", { name });
}

/** Where several people write, whether the viewer may stop or retry what `asker` asked: their own, a run no person
 * asked for, or any as an Owner or Admin (shown while that is still unknown; the server refuses the rest). */
export function mayActOn(asker: ResolvedSender | undefined, viewer: string, admin: boolean | null): boolean {
  return !asker?.id || asker.id === viewer || admin !== false;
}

export function useMayAct(): (asker: ResolvedSender | undefined) => boolean {
  const viewer = useReactor();
  const admin = useOwnerOrAdmin();
  return (asker) => mayActOn(asker, viewer, admin);
}

/** One quiet line under the working line: what runs next. The viewer's own waiting message shows to them alone, with
 * its remove control. */
export function SharedQueueLine({ waiting, viewer, onRemove, className }: {
  waiting: readonly Waiting[];
  viewer: string;
  onRemove: (queueId: string) => void;
  className?: string;
}) {
  const line = nextLine(waiting, viewer);
  if (!line) return null;
  const own = waiting.find((item) => item.sender?.id === viewer);
  return (
    <div className={cn("flex min-w-0 flex-col text-[12px] text-ink-tertiary", className)} data-shared-queue>
      <span className="truncate">{line}</span>
      {own && (
        <span className="flex min-w-0 items-center gap-1">
          <span dir="auto" className="truncate">{t("chat.queue.yoursWaiting", { text: own.text })}</span>
          <button
            type="button"
            onClick={() => onRemove(own.queueId)}
            aria-label={t("chat.queue.removeYours")}
            title={t("chat.queue.removeYours")}
            className="flex size-5 shrink-0 items-center justify-center rounded text-ink-tertiary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}

/** In a Team Cloud conversation several people write in: the working line's lead, the quiet line under it, and whether
 * the viewer may act on a request someone made. */
export function useSharedRun(bot: Bot, advanced: boolean): { label?: string; line: ReactNode; mayAct: (asker: ResolvedSender | undefined) => boolean } {
  const team = useStoreSelector((state) => Boolean(state.config?.team)), waiting = useStoreSelector((state) => state.pendingQueued[bot.threadId]), dispatch = useStoreDispatch();
  const viewer = useReactor();
  const mayAct = useMayAct();
  const task = team ? bot.tasks?.find((one) => one.threadId === bot.threadId && !one.private) : undefined;
  if (!task) return { line: null, mayAct: () => true };
  return {
    label: workingForLabel(task.askedBy, viewer),
    line: <SharedQueueLine waiting={waiting ?? []} viewer={viewer} className={advanced ? "ps-11" : "ps-12"}
      onRemove={(queueId) => dispatch({ type: "cancelQueued", botId: bot.id, threadId: bot.threadId, queueId })} />,
    mayAct,
  };
}
