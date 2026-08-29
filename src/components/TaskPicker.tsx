// One task list, rendered in the task-home rail. The chat header only keeps
// the bot title and global/thread tools; this component is the canonical task
// switcher and is intentionally reused by the compact popover.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers3, Plus, Trash2 } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { formatTokens } from "@/lib/format-tokens";
import { reportedTokenTurns } from "@/lib/usage";

function TaskUsage({ usage }: { usage: Task["usage"] }) {
  if (!usage) return null;
  if (reportedTokenTurns(usage) === 0) return <span title="Token counts not reported by this engine"> · tokens n/a</span>;
  const label = formatTokens(usage.input + usage.output);
  return label ? <span title={`${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out`}> · {label}</span> : null;
}

type TaskStatus = { label: string; tone: "quiet" | "active" | "needs"; detail: string };

function taskStatus(bot: Bot, task: Task): TaskStatus {
  const updates = task.threadId === bot.threadId ? visibleMessages(bot).filter((message) => message.kind === "activity").length : 0;
  if (task.threadId === bot.threadId && bot.activity === "waiting-on-you") return { label: "Needs you", tone: "needs", detail: `${updates} update${updates === 1 ? "" : "s"}` };
  if (task.threadId === bot.threadId && (bot.busy || bot.activity === "working")) return { label: "Working", tone: "active", detail: `${updates} update${updates === 1 ? "" : "s"}` };
  return { label: "Ready", tone: "quiet", detail: `${updates} update${updates === 1 ? "" : "s"}` };
}

export function TaskList({ bot, rail = false }: { bot: Bot; rail?: boolean }) {
  const { dispatch } = useStore();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const tasks = bot.tasks ?? [];

  const commitRename = (threadId: string) => {
    const title = draft.trim();
    setRenaming(null);
    if (title) dispatch({ type: "renameTask", botId: bot.id, threadId, title });
  };

  return (
    <section className={cn(rail && "centipede-task-list")} aria-label={`${bot.name} tasks`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">Tasks</h2>
          <p className="text-[10.5px] text-ink-secondary">Separate context for each job</p>
        </div>
        <span className="centipede-count-badge tabular-nums">{tasks.length}</span>
      </div>
      <div className="mt-2 max-h-[340px] space-y-1 overflow-y-auto">
        {tasks.map((task) => {
          const active = task.threadId === bot.threadId;
          const status = taskStatus(bot, task);
          return (
            <div key={task.threadId} className={cn("group rounded-xl border px-2.5 py-2", active ? "border-accent/35 bg-accent/8" : "border-hairline/25 hover:bg-raised/50")}>
              <div className="flex items-start gap-2">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", status.tone === "needs" ? "bg-warning" : status.tone === "active" ? "bg-accent" : "bg-ink-secondary/40")} aria-hidden="true" />
                {renaming === task.threadId ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(task.threadId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename(task.threadId);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    className="min-w-0 flex-1 rounded bg-inset px-1.5 py-0.5 text-[12.5px] text-ink focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!active) dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId });
                    }}
                    onDoubleClick={() => {
                      setDraft(task.title);
                      setRenaming(task.threadId);
                    }}
                    className="min-w-0 flex-1 text-left"
                    title="Click to switch · double-click to rename"
                  >
                    <div className="truncate text-[12.5px] font-medium text-ink">{task.title}</div>
                    <div className={cn("mt-0.5 flex items-center gap-1 text-[10.5px]", status.tone === "needs" ? "text-warning" : status.tone === "active" ? "text-accent-text" : "text-ink-secondary")}>
                      <span>{status.label}</span><span aria-hidden="true">·</span><span>{status.detail}</span><TaskUsage usage={task.usage} />
                    </div>
                  </button>
                )}
                <Check size={13} className={cn("mt-0.5 shrink-0", active ? "text-accent" : "opacity-0 group-hover:opacity-50")} aria-label={active ? "Selected task" : undefined} />
                <button
                  type="button"
                  onClick={() => dispatch({ type: "deleteTask", botId: bot.id, threadId: task.threadId })}
                  disabled={bot.busy && active}
                  aria-label={`Delete ${task.title}`}
                  title="Delete task"
                  className="rounded p-0.5 text-ink-secondary opacity-0 hover:bg-raised hover:text-danger group-hover:opacity-100 disabled:opacity-20"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => dispatch({ type: "newTask", botId: bot.id })}
        disabled={bot.busy}
        className="mt-2 flex w-full items-center gap-2 rounded-xl border border-dashed border-hairline/45 px-3 py-2 text-left text-[12px] text-ink-secondary hover:border-hairline hover:bg-raised/50 hover:text-ink disabled:opacity-40"
      >
        <Plus size={13} /> New task
      </button>
    </section>
  );
}

export function TaskPicker({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tasks = bot.tasks ?? [];
  const current = tasks.find((task) => task.threadId === bot.threadId);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const node = event.target instanceof Node ? event.target : null;
      if (!ref.current?.contains(node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (tasks.length <= 1) {
    return (
      <button
        type="button"
        onClick={() => dispatch({ type: "newTask", botId: bot.id })}
        disabled={bot.busy}
        title={bot.busy ? "Let this turn finish first" : "New task"}
        className={cn("centipede-control-chip is-task flex items-center gap-1 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40", COMPACT_BUBBLE)}
      >
        <span className="centipede-chip-glyph" aria-hidden="true"><Plus size={12} /></span><span className="@max-5xl/chathead:hidden">Task</span>
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className={cn("centipede-control-chip is-task flex max-w-[240px] items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:border-hairline/40 hover:bg-raised hover:text-ink", COMPACT_BUBBLE)} title="Switch task">
        <span className="centipede-chip-glyph" aria-hidden="true"><Layers3 size={12} /></span><span className="truncate @max-5xl/chathead:hidden">{current?.title ?? "Task"}</span><span className="centipede-count-badge shrink-0 tabular-nums @max-5xl/chathead:hidden">{tasks.length}</span><ChevronDown size={12} className="shrink-0 @max-5xl/chathead:hidden" />
      </button>
      {open && <div className="absolute right-0 top-full z-40 mt-2 w-[360px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-hairline/50 bg-card p-3 shadow-2xl shadow-black/40"><TaskList bot={bot} /></div>}
    </div>
  );
}
