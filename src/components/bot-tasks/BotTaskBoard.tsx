import { useMemo, useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";

import { BOT_TASK_STATUSES, type BotTaskStatus, type BotTaskSummary } from "../../../shared/bot-tasks";
import { groupByStatus, moveBotTask, proofRequired, STATUS_LABEL, type BotTasksStatus } from "@/lib/bot-tasks";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ApiError } from "@/state/api";
import { BotAvatar, type BotAvatarProps } from "../Avatar";
import { SidebarPopoverMenu } from "../SidebarPopoverMenu";
import { VerificationBadge } from "./BotTaskActivity";
import { BotTaskProofDialog } from "./BotTaskProofDialog";
import { GithubRefChip, When } from "./parts";

export type BoardBot = { id: string; name: string; avatar?: BotAvatarProps["bot"] };

const DOT: Record<BotTaskStatus, string> = {
  open: "bg-ink-tertiary", in_progress: "bg-ink-secondary", blocked: "bg-warning", review: "bg-ink-secondary", done: "bg-success", cancelled: "bg-ink-tertiary/60",
};

function BoardCard({ task, avatar, settings, dragging, onOpen, onMove, onDragStart, onDragEnd }: {
  task: BotTaskSummary;
  avatar?: BotAvatarProps["bot"];
  settings: BotTasksStatus;
  dragging: boolean;
  onOpen: () => void;
  onMove: (to: BotTaskStatus) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const items = BOT_TASK_STATUSES.filter((status) => status !== task.status).map((status, index) => ({
    key: status, label: t(STATUS_LABEL[status]), ...(index === 0 ? { heading: t("botTasks.board.moveTo") } : {}),
    ...(proofRequired(status, settings) ? { note: t("botTasks.board.needsProof") } : {}),
    onSelect: () => onMove(status),
  }));
  return (
    <li draggable onDragStart={onDragStart} onDragEnd={onDragEnd} data-bot-task-card={task.id} data-dragging={dragging || undefined}
      className={cn("group flex min-w-0 cursor-grab flex-col gap-2 rounded-xl border border-hairline/40 bg-card p-3 transition-colors hover:bg-ink/[0.03] active:cursor-grabbing motion-reduce:transition-none", dragging && "opacity-50")}>
      <div className="flex items-start gap-1">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 cursor-pointer text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <span dir="auto" title={task.title} className="line-clamp-2 break-words text-[13px] font-medium leading-[18px] text-ink">{task.title}</span>
        </button>
        <SidebarPopoverMenu placement="below" align="end" ariaLabel={t("botTasks.board.moveTo")} triggerClassName="-me-1 -mt-0.5 shrink-0"
          triggerLabel={t("botTasks.board.moveCard", { title: task.title })} items={items}
          renderTrigger={() => <span className="inline-flex size-7 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink"><MoreHorizontal size={16} aria-hidden="true" /></span>} />
      </div>
      {task.github && <div className="flex min-w-0"><GithubRefChip githubRef={task.github} compact /></div>}
      {Boolean(task.evidenceCount) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-bot-task-proof-summary="">
          <span className="text-[12px] leading-4 text-ink-secondary">{t("botTasks.board.proofCount", { count: task.evidenceCount ?? 0 })}</span>
          {task.evidenceStatus && <VerificationBadge verification={{ status: task.evidenceStatus, checkedAt: task.updatedAt }} bare />}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
        {avatar && <BotAvatar bot={avatar} size={16} />}
        <span className="min-w-0 flex-1 truncate">{task.ownerName}</span>
        <When at={task.updatedAt} />
      </div>
    </li>
  );
}

/** One column per status. A card moves by drag and drop or by the menu on the card; a move into a status that needs proof
 * opens the proof dialog first, and a refusal from the server is shown and the card stays where it is. */
export function BotTaskBoard({ tasks, settings, bots, onOpen, onChanged }: {
  tasks: readonly BotTaskSummary[];
  settings: BotTasksStatus;
  bots: readonly BoardBot[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const groups = useMemo(() => groupByStatus(tasks), [tasks]);
  const avatars = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.avatar])), [bots]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<BotTaskStatus>>(new Set(["cancelled"]));
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<BotTaskStatus | null>(null);
  const [proof, setProof] = useState<{ task: BotTaskSummary; to: BotTaskStatus } | null>(null);
  const [error, setError] = useState("");
  const [moved, setMoved] = useState("");
  const dragged = dragId ? tasks.find((task) => task.id === dragId) : undefined;

  const request = async (task: BotTaskSummary, to: BotTaskStatus) => {
    setError("");
    setMoved("");
    if (task.status === to) return;
    if (proofRequired(to, settings)) { setProof({ task, to }); return; }
    try {
      await moveBotTask(task.id, to);
      setMoved(t("botTasks.board.moved", { title: task.title, status: t(STATUS_LABEL[to]) }));
      onChanged();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t("botTasks.board.moveFailed"));
    }
  };
  const canDrop = (status: BotTaskStatus) => Boolean(dragged) && dragged!.status !== status;
  const toggle = (status: BotTaskStatus) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(status)) next.add(status);
    return next;
  });

  return (
    <div className="flex flex-col gap-2">
      {error && <p role="alert" data-bot-board-error="" dir="auto" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-4 text-danger">{error}</p>}
      <p role="status" className="sr-only">{moved}</p>
      <div data-bot-board={tasks.length} role="group" aria-label={t("botTasks.board.label")} className="flex items-start gap-2 overflow-x-auto pb-2">
        {BOT_TASK_STATUSES.map((status) => {
          const cards = groups[status];
          const shut = collapsed.has(status);
          const Chevron = shut ? ChevronRight : ChevronDown;
          return (
            <section key={status} data-bot-column={status} data-over={over === status && canDrop(status) ? "" : undefined} aria-label={t("botTasks.board.column", { status: t(STATUS_LABEL[status]), count: cards.length })}
              onDragOver={(event) => { if (canDrop(status)) { event.preventDefault(); setOver(status); } }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === status ? null : current)); }}
              onDrop={(event) => { event.preventDefault(); setOver(null); if (dragged && canDrop(status)) void request(dragged, status); setDragId(null); }}
              className={cn("flex min-w-0 flex-col gap-2 rounded-xl bg-ink/[0.04] p-2 transition-colors motion-reduce:transition-none",
                shut ? "w-32 shrink-0" : "min-w-[11rem] flex-1 basis-0", over === status && canDrop(status) && "bg-ink/[0.09] outline outline-2 -outline-offset-2 outline-focus")}>
              <h3 className="m-0">
                <button type="button" aria-expanded={!shut} onClick={() => toggle(status)} data-bot-column-toggle={status}
                  title={t(shut ? "botTasks.board.expand" : "botTasks.board.collapse", { status: t(STATUS_LABEL[status]) })}
                  className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-1 text-start focus-visible:outline-2 focus-visible:outline-focus">
                  <Chevron size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[status])} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px] text-ink">{t(STATUS_LABEL[status])}</span>
                  <span data-bot-column-count="" className="text-[12px] font-medium leading-4 tabular-nums text-ink-tertiary">{cards.length}</span>
                </button>
              </h3>
              {!shut && (cards.length ? (
                <ul className="flex flex-col gap-2">
                  {cards.map((task) => (
                    <BoardCard key={task.id} task={task} avatar={avatars.get(task.ownerBotId)} settings={settings} dragging={dragId === task.id}
                      onOpen={() => onOpen(task.id)} onMove={(to) => void request(task, to)}
                      onDragStart={(event) => { setDragId(task.id); event.dataTransfer?.setData("text/plain", task.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; }}
                      onDragEnd={() => { setDragId(null); setOver(null); }} />
                  ))}
                </ul>
              ) : <p className="px-1 py-3 text-center text-[12px] leading-4 text-ink-tertiary">{t("botTasks.board.empty")}</p>)}
            </section>
          );
        })}
      </div>
      {proof && <BotTaskProofDialog key={`${proof.task.id}:${proof.to}`} task={proof.task} to={proof.to} onClose={() => setProof(null)}
        onMoved={(id, to) => { const title = tasks.find((task) => task.id === id)?.title ?? id; setMoved(t("botTasks.board.moved", { title, status: t(STATUS_LABEL[to]) })); onChanged(); }} />}
    </div>
  );
}
