import { X } from "lucide-react";
import type { ReactNode } from "react";

import type { ResolvedSender } from "../../shared/wire";
import { useReactor } from "@/lib/cloud-guest";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";

type Waiting = { queueId: string; sender?: ResolvedSender };

/** The working line's lead in a conversation several people write in: whose request runs. */
export function workingForLabel(askedBy: ResolvedSender | undefined, viewer: string): string | undefined {
  if (!askedBy) return undefined;
  return askedBy.id === viewer ? t("chat.queue.workingForYou") : t("chat.queue.workingFor", { name: askedBy.name });
}

/** "Next: Tom's request, then 2 more", or null when nothing waits. */
export function nextLine(waiting: readonly Waiting[], viewer: string): string | null {
  const [head] = waiting;
  if (!head) return null;
  const mine = head.sender?.id === viewer;
  const name = head.sender?.name ?? "";
  const more = waiting.length - 1;
  if (more > 0) return mine ? t("chat.queue.nextYoursMore", { count: more }) : t("chat.queue.nextMore", { name, count: more });
  return mine ? t("chat.queue.nextYours") : t("chat.queue.next", { name });
}

/** One quiet line under the working line: what runs next, with a remove control for the viewer's own waiting message. */
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
    <p className={cn("flex min-w-0 items-center gap-1 text-[12px] text-ink-tertiary", className)} data-shared-queue>
      <span className="truncate">{line}</span>
      {own && (
        <button
          type="button"
          onClick={() => onRemove(own.queueId)}
          aria-label={t("chat.queue.removeYours")}
          title={t("chat.queue.removeYours")}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-tertiary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </p>
  );
}

/** In a Team Cloud conversation several people write in: the working line's lead and the quiet line under it. */
export function useSharedRun(bot: Bot, advanced: boolean): { label?: string; line: ReactNode } {
  const { state, dispatch } = useStore();
  const viewer = useReactor();
  const task = state.config?.team ? bot.tasks?.find((one) => one.threadId === bot.threadId && !one.private) : undefined;
  if (!task) return { line: null };
  return {
    label: workingForLabel(task.askedBy, viewer),
    line: <SharedQueueLine waiting={state.pendingQueued[bot.threadId] ?? []} viewer={viewer} className={advanced ? "ps-11" : "ps-12"}
      onRemove={(queueId) => dispatch({ type: "cancelQueued", botId: bot.id, threadId: bot.threadId, queueId })} />,
  };
}
