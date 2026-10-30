import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isTickable } from "@/lib/bulk-select";
import { currentTaskBot, useStore, type Action, type Bot } from "@/state/store";
import { bulkDeleteBody, bulkDeleteOutcome, deleteThreadsInBulk } from "./BulkSelectBar";
import { ConfirmDialog } from "./ConfirmDialog";

export function BotDeleteMenuItem({ deleting, onClick, className = "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]" }: { deleting: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      disabled={deleting}
      aria-busy={deleting || undefined}
      onClick={onClick}
      title={deleting ? t("sidebar.bot.deleteCheckingTitle") : undefined}
      className={cn(
        className,
        "text-danger",
        deleting ? "cursor-default opacity-40" : "hover:bg-menu-hover",
      )}
    >
      {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      {deleting ? t("sidebar.bot.deleteChecking") : t("common.delete")}
    </button>
  );
}

export function allThreadRows(bot: Bot) {
  return (bot.tasks ?? []).filter((task) => !task.routineRunId).map((task) => {
    const thread = currentTaskBot(bot, task.threadId);
    return { ...task, busy: thread.busy, activity: thread.activity };
  });
}

type Dispatch = (action: Action) => void;

export async function deleteAllThreads(bot: Bot, dispatch: Dispatch): Promise<void> {
  const outcome = await deleteThreadsInBulk({ botId: bot.id }, allThreadRows(bot).map((row) => row.threadId), dispatch);
  dispatch({ type: "notice", notice: { kind: "note", botName: null, text: bulkDeleteOutcome(outcome) } });
}

export function deleteAllThreadsCopy(rows: ReturnType<typeof allThreadRows>, simple = false) {
  const ids = new Set(rows.map((row) => row.threadId));
  const startsFresh = rows.every(isTickable);
  return {
    title: t(simple ? "task.deleteAllConversationsConfirm" : "task.deleteAllConfirm", { count: rows.length }),
    body: bulkDeleteBody(rows, ids, startsFresh),
    confirmLabel: t("task.bulk.delete", { count: rows.length }),
  };
}

export function useDeleteAllThreads(simple = false) {
  const { state, dispatch } = useStore();
  const [botId, setBotId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const bot = botId === null ? undefined : state.bots.find((candidate) => candidate.id === botId);
  const run = () => {
    if (!bot || pending) return;
    setPending(true);
    void deleteAllThreads(bot, dispatch).finally(() => { setPending(false); setBotId(null); });
  };
  const dialog = <ConfirmDialog open={bot !== undefined} {...deleteAllThreadsCopy(bot ? allThreadRows(bot) : [], simple)} icon={<Trash2 size={18} />}
    pending={pending} onCancel={() => { if (!pending) setBotId(null); }} onConfirm={run} />;
  return { ask: setBotId, dialog };
}
