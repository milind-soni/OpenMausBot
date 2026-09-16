// The board screen (Phase 3 part 2): the durable task board by status, each
// card saying who has it, what it cost, why it waits, what the gates said
// and what came out. Every action goes through the board's existing routes;
// this page never becomes a second scheduler.
import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  BOARD_COLUMNS,
  BUDGET_PAUSED_REASON,
  cardTone,
  dropTargets,
  groupByStatus,
  raiseStep,
  spendLabel,
  type BoardColumn,
  type BoardTaskView,
  type CardTone,
} from "@/lib/task-board-view";

const POLL_MS = 10_000;

const toneClass: Record<CardTone, string> = {
  none: "border-border",
  accent: "border-accent/60",
  warning: "border-warning/70",
  danger: "border-danger/70",
};

export function TaskBoardPage({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [tasks, setTasks] = useState<BoardTaskView[] | null>(null);
  const [dragging, setDragging] = useState<BoardTaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api("/api/tasks");
      setTasks((response?.tasks ?? []) as BoardTaskView[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const patch = async (task: BoardTaskView, body: Record<string, unknown>) => {
    setBusy(task.id);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const botName = (id: string | null) => (id ? state.bots.find((bot) => bot.id === id)?.name ?? id.slice(0, 8) : null);
  const grouped = groupByStatus(tasks ?? []);

  return (
    // min-w-0 + overflow-hidden: the page must never be wider than the
    // window. Without them a nowrap line inside (a subtitle, a long title)
    // sets the page's minimum width and the right edge is cut off.
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-5">
        <ClipboardList size={18} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1 basis-40">
          <h1 className="text-[15px] font-semibold text-ink">{t("board.title")}</h1>
          <p className="hidden text-[12px] text-ink-secondary md:block">{t("board.subtitle")}</p>
        </div>
        <button type="button" onClick={() => void load()} title={t("board.refresh")} aria-label={t("board.refresh")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink">
          <RefreshCw size={16} />
        </button>
        <button type="button" onClick={() => setComposing(true)} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
          <Plus size={14} />{t("board.new.button")}
        </button>
        <button type="button" onClick={onClose} title={t("board.close")} aria-label={t("board.close")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={16} />
        </button>
      </header>
      {error && <div className="mx-5 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("board.error", { message: error })}</div>}
      {composing && (
        <NewTaskForm
          bots={state.bots.map((bot) => ({ id: bot.id, name: bot.name }))}
          onClose={() => setComposing(false)}
          onFiled={() => { setComposing(false); void load(); }}
          onError={setError}
        />
      )}
      {tasks === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={16} className="animate-spin" />{t("board.loading")}</div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-secondary">{t("board.empty")}</div>
      ) : (
        // Columns fit the page's own width, not the window's: as many as
        // fit at 200px each, so a narrow window shows two and a wide one six.
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(200px,1fr))] content-start gap-3 overflow-y-auto px-4 py-4 sm:px-5">
          {BOARD_COLUMNS.map((column) => (
            <BoardColumnView key={column} column={column} tasks={grouped[column]} botName={botName} busy={busy} patch={patch}
              openRun={(task) => { if (task.assigneeBotId && task.threadId) dispatch({ type: "switchTask", botId: task.assigneeBotId, threadId: task.threadId }); }}
              bots={state.bots.map((bot) => ({ id: bot.id, name: bot.name }))}
              dragging={dragging} setDragging={setDragging}
              onDrop={(task, status) => { setDragging(null); void patch(task, { status }); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function BoardColumnView({ column, tasks, botName, busy, patch, openRun, bots, dragging, setDragging, onDrop }: {
  column: BoardColumn;
  tasks: BoardTaskView[];
  botName: (id: string | null) => string | null;
  busy: string | null;
  patch: (task: BoardTaskView, body: Record<string, unknown>) => Promise<void>;
  openRun: (task: BoardTaskView) => void;
  bots: Array<{ id: string; name: string }>;
  dragging: BoardTaskView | null;
  setDragging: (task: BoardTaskView | null) => void;
  onDrop: (task: BoardTaskView, status: BoardColumn) => void;
}) {
  const accepts = dragging !== null && dropTargets(dragging.status).includes(column);
  const [over, setOver] = useState(false);
  return (
    <section
      className={cn("flex min-h-40 min-w-0 flex-col rounded-xl bg-raised/40 transition-shadow", accepts && "ring-1 ring-accent/60", accepts && over && "bg-accent/10", dragging && !accepts && dragging.status !== column && "opacity-50")}
      aria-label={t(`board.column.${column}`)}
      onDragOver={(event) => { if (accepts) { event.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => { setOver(false); if (accepts && dragging) { event.preventDefault(); onDrop(dragging, column); } }}
    >
      <h2 className="flex items-center justify-between px-3 pt-3 pb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
        {t(`board.column.${column}`)}<span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-normal">{tasks.length}</span>
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
        {tasks.map((task) => (
          <BoardCard key={task.id} task={task} botName={botName} busy={busy === task.id} patch={patch} openRun={openRun} bots={bots}
            draggable={dropTargets(task.status).length > 0}
            onDragStart={() => setDragging(task)} onDragEnd={() => setDragging(null)} />
        ))}
      </div>
    </section>
  );
}

function BoardCard({ task, botName, busy, patch, openRun, bots, draggable, onDragStart, onDragEnd }: {
  task: BoardTaskView;
  botName: (id: string | null) => string | null;
  busy: boolean;
  patch: (task: BoardTaskView, body: Record<string, unknown>) => Promise<void>;
  openRun: (task: BoardTaskView) => void;
  bots: Array<{ id: string; name: string }>;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const assignee = botName(task.assigneeBotId);
  const spend = spendLabel(task);
  const paused = task.status === "blocked" && task.blockedReason === BUDGET_PAUSED_REASON;
  const gateFailed = task.gates?.results.some((r) => r.status !== "pass") ?? false;
  return (
    <article
      draggable={draggable}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); onDragStart(); }}
      onDragEnd={onDragEnd}
      title={draggable ? t("board.card.dragHint") : undefined}
      className={cn("min-w-0 rounded-lg border bg-canvas p-3 text-[12.5px] shadow-sm", toneClass[cardTone(task)], busy && "opacity-60", draggable && "cursor-grab active:cursor-grabbing")}>
      <div className="break-words font-medium text-ink">{task.title}</div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11.5px] text-ink-secondary">
        <span>{assignee ?? t("board.card.unassigned")}</span>
        {task.owner && <span>· {t("board.card.owner", { name: botName(task.owner) ?? task.owner })}</span>}
        {typeof task.dueAt === "number" && <span>· {t("board.card.due", { date: new Date(task.dueAt).toLocaleDateString() })}</span>}
        {spend && <span>· {spend}</span>}
        {task.attempts > 1 && <span>· {t("board.card.attempts", { count: task.attempts })}</span>}
      </div>
      {task.hold && <p className="mt-2 break-words rounded bg-warning/10 px-2 py-1 text-[11.5px] text-ink">{t("board.card.waiting", { reason: task.hold })}</p>}
      {task.status === "blocked" && task.blockedReason && <p className="mt-2 break-words rounded bg-danger/10 px-2 py-1 text-[11.5px] text-ink">{t("board.card.paused", { reason: task.blockedReason })}</p>}
      {task.gates && <p className={cn("mt-2 break-words text-[11.5px]", gateFailed ? "text-danger" : "text-ink-secondary")}>{task.gates.scope}</p>}
      {task.result && (
        <details className="mt-2 text-[11.5px] text-ink-secondary">
          <summary className="cursor-pointer select-none">{t("board.card.result")}</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-raised/60 p-2 text-[11px] text-ink">{task.result}</pre>
        </details>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {task.status === "todo" && <CardButton onClick={() => void patch(task, { status: "ready" })}>{t("board.action.start")}</CardButton>}
        {paused && <CardButton onClick={() => void patch(task, { budgetUsd: (task.budgetUsd ?? 0) + raiseStep(task.budgetUsd) })}>{t("board.action.allowMore", { amount: raiseStep(task.budgetUsd).toFixed(2) })}</CardButton>}
        {paused && <CardButton onClick={() => void patch(task, { budgetUsd: null, status: "ready" })}>{t("board.action.noCap")}</CardButton>}
        {task.status === "review" && <CardButton onClick={() => void patch(task, { status: "done" })}>{t("board.action.done")}</CardButton>}
        {task.status === "review" && <CardButton onClick={() => void patch(task, { status: "ready" })}>{t("board.action.reopen")}</CardButton>}
        {(task.status === "todo" || task.status === "ready" || task.status === "blocked") && (
          assigning ? (
            <select autoFocus className="rounded border border-border bg-canvas px-1.5 py-0.5 text-[11.5px] text-ink" defaultValue={task.assigneeBotId ?? ""}
              onBlur={() => setAssigning(false)}
              onChange={(event) => { setAssigning(false); void patch(task, { assigneeBotId: event.target.value || null }); }}>
              <option value="">{t("board.new.nobody")}</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          ) : <CardButton onClick={() => setAssigning(true)}>{t("board.action.assign")}</CardButton>
        )}
        {task.threadId && task.assigneeBotId && <CardButton onClick={() => openRun(task)}>{t("board.action.openThread")}</CardButton>}
        {(task.status === "done" || task.status === "blocked" || task.status === "todo") && <CardButton onClick={() => void patch(task, { status: "archived" })}>{t("board.action.archive")}</CardButton>}
      </div>
    </article>
  );
}

function CardButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="rounded border border-border bg-canvas px-2 py-0.5 text-[11.5px] text-ink hover:bg-raised">{children}</button>;
}

function NewTaskForm({ bots, onClose, onFiled, onError }: { bots: Array<{ id: string; name: string }>; onClose: () => void; onFiled: () => void; onError: (message: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [budget, setBudget] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const cap = Number(budget);
      await api("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body, ...(assignee ? { assigneeBotId: assignee } : {}), ...(Number.isFinite(cap) && cap > 0 ? { budgetUsd: cap } : {}) }),
      });
      onFiled();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="mx-5 mt-3 grid gap-2 rounded-xl border border-border bg-raised/40 p-3 text-[12.5px] sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-ink-secondary">{t("board.new.title")}</span>
        <input id="board-new-title" value={title} onChange={(event) => setTitle(event.target.value)} className="rounded border border-border bg-canvas px-2 py-1 text-ink" autoFocus /></label>
      <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-ink-secondary">{t("board.new.body")}</span>
        <textarea id="board-new-body" value={body} onChange={(event) => setBody(event.target.value)} rows={3} className="rounded border border-border bg-canvas px-2 py-1 text-ink" /></label>
      <label className="flex flex-col gap-1"><span className="text-ink-secondary">{t("board.new.assignee")}</span>
        <select id="board-new-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)} className="rounded border border-border bg-canvas px-2 py-1 text-ink">
          <option value="">{t("board.new.nobody")}</option>
          {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select></label>
      <label className="flex flex-col gap-1"><span className="text-ink-secondary">{t("board.new.budget")}</span>
        <input id="board-new-budget" value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" className="rounded border border-border bg-canvas px-2 py-1 text-ink" /></label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={saving || !title.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">{t("board.new.submit")}</button>
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised">{t("board.new.cancel")}</button>
      </div>
    </form>
  );
}
