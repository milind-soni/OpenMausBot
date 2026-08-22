// A bot's tasks: separate contexts on the same bot.
//
// One endless thread per bot means every job contaminates the next, and
// the only clean slate is a second bot. A task is a real boundary — its
// own transcript and its own provider session — so sensitive work, a
// long job and a quick question can sit side by side under one agent.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useStore, formatTime, type Bot, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { formatTokens } from "@/lib/format-tokens";

/** Quiet per-task token tally — input+output combined, because one honest
 * total reads faster than a split; the split lives in the hover title. */
function TaskUsage({ usage }: { usage: Task["usage"] }) {
  if (!usage) return null;
  const label = formatTokens(usage.input + usage.output);
  if (!label) return null;
  return (
    <span title={`${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out`}>
      {" · "}
      {label}
    </span>
  );
}

export function TaskPicker({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const tasks = bot.tasks ?? [];
  const current = tasks.find((t) => t.threadId === bot.threadId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // SAFETY: a mousedown target inside a document is always a DOM Node
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // a bot that has only ever done one thing doesn't need a switcher yet —
  // just the button that gives it a second context
  if (tasks.length <= 1) {
    return (
      <button
        onClick={() => dispatch({ type: "newTask", botId: bot.id })}
        disabled={bot.busy}
        title={bot.busy ? "Let this turn finish first" : "New task — a fresh context on this bot"}
        className={cn(
          "flex items-center gap-1 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40",
          COMPACT_BUBBLE,
        )}
      >
        <Plus size={12} className="@max-4xl/chathead:size-[14px]" />
        <span className="@max-4xl/chathead:hidden">Task</span>
      </button>
    );
  }

  const commitRename = (threadId: string) => {
    const title = draft.trim();
    setRenaming(null);
    if (title) dispatch({ type: "renameTask", botId: bot.id, threadId, title });
  };

  // the picker button stays as-is — a token count next to a truncated title
  // and count would crowd it; the open task's tally rides the hover title
  const u = current?.usage;
  const currentLabel = u ? formatTokens(u.input + u.output) : null;
  const switchTitle =
    u && currentLabel
      ? `Switch task · ${currentLabel} (${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out)`
      : "Switch task";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={switchTitle}
        className={cn(
          "flex max-w-[220px] items-center gap-1.5 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink",
          COMPACT_BUBBLE,
        )}
      >
        <span className="truncate @max-4xl/chathead:hidden">{current?.title ?? "Task"}</span>
        {/* folded: just the count in the bubble — the title rides the tooltip */}
        <span className="shrink-0 tabular-nums opacity-60 @max-4xl/chathead:opacity-100">{tasks.length}</span>
        <ChevronDown size={12} className="shrink-0 @max-4xl/chathead:hidden" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[300px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1 shadow-2xl shadow-black/50">
          <div className="max-h-[320px] overflow-y-auto">
            {tasks.map((task) => {
              const active = task.threadId === bot.threadId;
              return (
                <div
                  key={task.threadId}
                  className={cn("group flex items-center gap-2 px-2.5 py-2", active ? "bg-raised/60" : "hover:bg-raised/40")}
                >
                  <Check size={13} className={cn("shrink-0", active ? "text-accent" : "opacity-0")} />
                  {renaming === task.threadId ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(task.threadId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(task.threadId);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="min-w-0 flex-1 rounded bg-inset px-1.5 py-0.5 text-[13px] text-ink focus:outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        if (!active) dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId });
                        setOpen(false);
                      }}
                      onDoubleClick={() => {
                        setDraft(task.title);
                        setRenaming(task.threadId);
                      }}
                      className="min-w-0 flex-1 text-left"
                      title="Click to switch · double-click to rename"
                    >
                      <div className="truncate text-[13px] text-ink">{task.title}</div>
                      <div className="text-[11px] text-ink-secondary">
                        {formatTime(task.createdAt)}
                        <TaskUsage usage={task.usage} />
                      </div>
                    </button>
                  )}
                  <button
                    onClick={() => dispatch({ type: "deleteTask", botId: bot.id, threadId: task.threadId })}
                    disabled={bot.busy && active}
                    aria-label="Delete task"
                    title="Delete this task and its conversation"
                    className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-danger group-hover:opacity-100 disabled:opacity-20"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => {
              dispatch({ type: "newTask", botId: bot.id });
              setOpen(false);
            }}
            disabled={bot.busy}
            className="mt-1 flex w-full items-center gap-2 border-t border-hairline/40 px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/50 disabled:opacity-40"
          >
            <Plus size={13} className="text-ink-secondary" /> New task
          </button>
        </div>
      )}
    </div>
  );
}
