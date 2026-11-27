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
    // A closed thread keeps its own state: the bot working in another thread must not make it look running.
    if (task.closedBy) return { ...task, busy: task.busy ?? (task.activity === "working" || task.activity === "waiting-on-you"), activity: task.activity };
    const thread = currentTaskBot(bot, task.threadId);
    return { ...task, busy: thread.busy, activity: thread.activity };
  });
}

type Dispatch = (action: Action) => void;
type ThreadRows = ReturnType<typeof allThreadRows>;
export type DeleteScope = "all" | "closed";

export const closedThreadRows = (rows: ThreadRows): ThreadRows =>
  rows.filter((row) => Boolean(row.closedBy) && row.pinned !== true && isTickable(row));

const scopedRows = (rows: ThreadRows, scope: DeleteScope): ThreadRows => (scope === "closed" ? closedThreadRows(rows) : rows);

export async function deleteAllThreads(bot: Bot, dispatch: Dispatch, scope: DeleteScope = "all"): Promise<void> {
  const outcome = await deleteThreadsInBulk({ botId: bot.id }, scopedRows(allThreadRows(bot), scope).map((row) => row.threadId), dispatch, scope);
  dispatch({ type: "notice", notice: { kind: "note", botName: null, text: bulkDeleteOutcome(outcome) } });
}

const confirmTitle = {
  all: { simple: "task.deleteAllConversationsConfirm", advanced: "task.deleteAllConfirm" },
  closed: { simple: "task.deleteClosedConversationsConfirm", advanced: "task.deleteClosedConfirm" },
} as const;

export function deleteAllThreadsCopy(rows: ThreadRows, simple = false, scope: DeleteScope = "all") {
  const picked = scopedRows(rows, scope);
  const ids = new Set(picked.map((row) => row.threadId));
  const startsFresh = rows.every(isTickable);
  return {
    title: t(confirmTitle[scope][simple ? "simple" : "advanced"], { count: picked.length }),
    body: bulkDeleteBody(rows, ids, startsFresh),
    confirmLabel: t("task.bulk.delete", { count: picked.length }),
  };
}

export function useDeleteAllThreads(simple = false) {
  const { state, dispatch } = useStore();
  const [asked, setAsked] = useState<{ botId: string; scope: DeleteScope } | null>(null);
  const [pending, setPending] = useState(false);
  const bot = asked === null ? undefined : state.bots.find((candidate) => candidate.id === asked.botId);
  const scope = asked?.scope ?? "all";
  const run = () => {
    if (!bot || pending) return;
    setPending(true);
    void deleteAllThreads(bot, dispatch, scope).finally(() => { setPending(false); setAsked(null); });
  };
  const dialog = <ConfirmDialog open={bot !== undefined} {...deleteAllThreadsCopy(bot ? allThreadRows(bot) : [], simple, scope)} icon={<Trash2 size={18} />}
    pending={pending} onCancel={() => { if (!pending) setAsked(null); }} onConfirm={run} />;
  return { ask: (botId: string, askedScope: DeleteScope = "all") => setAsked({ botId, scope: askedScope }), dialog };
}
