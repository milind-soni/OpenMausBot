// Separate task contexts for an agent or a channel.
//
// One endless thread per bot means every job contaminates the next, and
// the only clean slate is a second bot. A task is a real boundary — its
// own transcript and its own provider session — so sensitive work, a
// long job and a quick question can sit side by side under one agent.
import { Fragment, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderInput, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useStore, formatTime, type Bot, type BotProject, type Group, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { formatTaskTokens } from "@/lib/usage";
import { nextRename } from "@/lib/rename";
import { FolderIcon, NewThreadButton } from "./BotProjects";
import { useShowThreads } from "@/lib/thread-preferences";
import { sidebarBotActivityTasks } from "./SidebarBotActivity";
import { threadOpenerLabel } from "./SidebarThreadRow";

/** Click-to-switch used to close this menu immediately, which unmounted the
 * row before a double-click (or right-click) could start a rename. Linger
 * just long enough for the second click to land; rename cancels the close. */
export const TASK_PICKER_DISMISS_MS = 500;


/** Decide what a pointer event on a task row should do. The click that
 * accompanies a dblclick (detail >= 2) must not switch/close — that is
 * what used to eat the advertised rename. */
export function taskPickerPointerIntent(
  type: string,
  detail = 1,
): "select" | "rename" | "ignore" {
  if (type === "dblclick" || type === "contextmenu") return "rename";
  if (type === "click" && detail >= 2) return "ignore";
  if (type === "click") return "select";
  return "ignore";
}

/** Filter the task switcher. Prefix matches float first so a few letters
 * still find the right row in a long list; within a tier the caller's
 * order (newest first) is preserved. */
export function filterTasks<T extends { title: string }>(tasks: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tasks];
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const task of tasks) {
    const title = task.title.toLowerCase();
    if (title.startsWith(needle)) prefix.push(task);
    else if (title.includes(needle)) substring.push(task);
  }
  return [...prefix, ...substring];
}

/** Quiet per-task token tally — input+output combined, because one honest
 * total reads faster than a split; the split lives in the hover title. */
function TaskUsage({ usage }: { usage: Task["usage"] }) {
  if (!usage) return null;
  const label = formatTaskTokens(usage.input + usage.output);
  if (!label) return null;
  return (
    <span
      title={`${t("chat.usage.in", { tokens: usage.input.toLocaleString() })} · ${t("chat.usage.out", { tokens: usage.output.toLocaleString() })}`}
    >
      {" · "}
      {label}
    </span>
  );
}

type PickerTask = Pick<Task, "threadId" | "title" | "createdAt" | "busy" | "activity" | "unread" | "projectId" | "openedBy"> & { usage?: Task["usage"] };

/** The full picker searches both thread titles and their project names.
 * Legacy/orphaned project IDs remain visible under Ungrouped. */
export function groupThreadTasks(tasks: PickerTask[], projects: BotProject[], query: string) {
  const needle = query.trim().toLowerCase();
  return [...projects, { id: "", name: t("folder.none") } as BotProject].map((project) => {
    const members = tasks.filter((task) => project.id ? task.projectId === project.id : !projects.some((item) => item.id === task.projectId));
    return { project, tasks: project.name.toLowerCase().includes(needle) ? members : filterTasks(members, query) };
  }).filter((group) => group.tasks.length > 0);
}

function ConversationTaskPicker({
  threadId,
  tasks,
  busy,
  bot,
  onNew,
  onSwitch,
  onRename,
  onDelete,
  onMove,
}: {
  threadId: string;
  tasks: PickerTask[];
  busy: boolean;
  bot?: Bot;
  onNew: () => void;
  onSwitch: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
  onMove?: (threadId: string, projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishingRename = useRef(false);

  const current = tasks.find((t) => t.threadId === threadId);

  const clearDismiss = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };

  const closeMenu = () => {
    clearDismiss();
    setRenaming(null);
    setQuery("");
    setOpen(false);
  };

  const queueDismiss = () => {
    clearDismiss();
    dismissTimer.current = setTimeout(() => {
      dismissTimer.current = null;
      setRenaming(null);
      setOpen(false);
    }, TASK_PICKER_DISMISS_MS);
  };

  const startRename = (task: PickerTask) => {
    clearDismiss();
    finishingRename.current = false;
    setDraft(task.title);
    setRenaming(task.threadId);
  };

  useEffect(() => () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  useEffect(() => {
    if (!open) {
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      setRenaming(null);
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-thread-overlay]")) return;
      // SAFETY: a mousedown target inside a document is always a DOM Node
      if (!ref.current?.contains(e.target as Node)) {
        if (dismissTimer.current) {
          clearTimeout(dismissTimer.current);
          dismissTimer.current = null;
        }
        setRenaming(null);
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof Element && e.target.closest("[data-thread-overlay]")) return;
      if (renaming) return;
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      setRenaming(null);
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, renaming]);

  const commitRename = (threadId: string, save: boolean) => {
    // Escape unmounts the input, which fires blur. Without this guard the
    // blur would save the draft the user just cancelled.
    if (finishingRename.current) return;
    finishingRename.current = true;
    const currentTitle = tasks.find((task) => task.threadId === threadId)?.title ?? "";
    const title = save ? nextRename(currentTitle, draft) : null;
    setRenaming(null);
    if (title) onRename(threadId, title);
  };

  // the picker button stays as-is — a token count next to a truncated title
  // and count would crowd it; the open task's tally rides the hover title
  const u = current?.usage;
  const currentLabel = u ? formatTaskTokens(u.input + u.output) : null;
  const switchTitle =
    u && currentLabel
      ? t("task.switchWithUsage", {
          label: currentLabel,
          input: u.input.toLocaleString(),
          output: u.output.toLocaleString(),
        })
      : t("task.switch");
  const grouped = bot ? groupThreadTasks(tasks, bot.projects ?? [], query) : null;
  const visible = grouped ? grouped.flatMap((group) => group.tasks) : filterTasks(tasks, query);
  const looking = query.trim();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          if (open) closeMenu();
          else setOpen(true);
        }}
        title={switchTitle}
        aria-label={t("task.switch")}
        className={cn(
          "flex max-w-[220px] items-center gap-1.5 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink",
          COMPACT_BUBBLE,
        )}
      >
        <span className="truncate @max-4xl/chathead:hidden">{t("task.switch")}</span>
        {/* folded: just the count in the bubble — the title rides the tooltip */}
        <span className="shrink-0 tabular-nums opacity-60 @max-4xl/chathead:opacity-100">{tasks.length}</span>
        <ChevronDown size={12} className="shrink-0 @max-4xl/chathead:hidden" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[300px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1 shadow-2xl shadow-black/50">
          <div className="px-2 pb-1 pt-1.5">
            <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-accent/60">
              <Search size={13} className="shrink-0 text-ink-secondary" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (looking) setQuery("");
                    else closeMenu();
                    return;
                  }
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const first = visible[0];
                    if (!first) return;
                    if (first.threadId !== threadId) onSwitch(first.threadId);
                    closeMenu();
                  }
                }}
                placeholder={t("task.search")}
                aria-label={t("task.search")}
                className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-[320px] overflow-y-auto" role="group" aria-label={looking ? t("task.matching", { count: visible.length }) : t("task.list")}>
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
                {t("task.noMatch", { query: looking })}
              </div>
            ) : visible.map((task, index) => {
              const active = task.threadId === threadId;
              const opener = threadOpenerLabel(task);
              const heading = grouped?.find((group) => group.tasks[0]?.threadId === task.threadId)?.project;
              return (
                <Fragment key={task.threadId}>
                {bot?.projects?.length && heading ? <div className={cn("flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-medium text-ink-secondary", index > 0 && "border-t border-hairline/30")}>{heading.id && <FolderIcon emoji={heading.emoji} size={12} />}{heading.name}</div> : null}
                <div
                  className={cn("group flex items-center gap-2 px-2.5 py-2", active ? "bg-raised/60" : "hover:bg-raised/40")}
                >
                  <Check size={13} className={cn("shrink-0", active ? "text-accent" : "opacity-0")} />
                  {renaming === task.threadId ? (
                    <input
                      autoFocus
                      value={draft}
                      maxLength={80}
                      aria-label={t("task.renameAria")}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onBlur={() => commitRename(task.threadId, true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.stopPropagation();
                          commitRename(task.threadId, true);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          commitRename(task.threadId, false);
                        }
                      }}
                      className="min-w-0 flex-1 rounded bg-inset px-1.5 py-0.5 text-[13px] text-ink focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        if (taskPickerPointerIntent("click", e.detail) !== "select") return;
                        if (!active) onSwitch(task.threadId);
                        queueDismiss();
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startRename(task);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startRename(task);
                      }}
                      className="min-w-0 flex-1 text-left"
                      title={t("task.renameHint")}
                    >
                      <div className="truncate text-[13px] text-ink">{task.title}</div>
                      <div className="text-[11px] text-ink-secondary">
                        {task.activity === "waiting-on-you" ? `${t("task.waiting")} · ` : task.busy ? `${t("chat.activity.working")} · ` : task.unread ? `${t("task.unread")} · ` : ""}
                        {formatTime(task.createdAt)}
                        <TaskUsage usage={task.usage} />
                        {opener && ` · ${opener}`}
                      </div>
                    </button>
                  )}
                  {renaming !== task.threadId && (
                    <button
                      type="button"
                      onClick={() => startRename(task)}
                      aria-label={t("task.renameNamed", { title: task.title })}
                      title={t("task.renameTitle")}
                      className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {bot && onMove && (bot.projects?.length ?? 0) > 0 && <label title={t("folder.move")} className="relative rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-within:opacity-100 group-hover:opacity-100">
                    <FolderInput size={13} />
                    <select aria-label={t("folder.moveNamed", { title: task.title })} value={bot.projects?.some((project) => project.id === task.projectId) ? task.projectId : ""}
                      onFocus={clearDismiss} onChange={(event) => { clearDismiss(); onMove(task.threadId, event.target.value || null); }}
                      className="absolute inset-0 w-full cursor-pointer opacity-0">
                      <option value="">{t("folder.none")}</option>
                      {bot.projects?.map((project) => <option key={project.id} value={project.id}>{project.emoji ? `${project.emoji} ` : ""}{project.name}</option>)}
                    </select>
                  </label>}
                  <button
                    type="button"
                    onClick={() => onDelete(task.threadId)}
                    disabled={Boolean(task.busy) || busy && active}
                    aria-label={t("task.deleteAria")}
                    title={t("task.deleteTitle")}
                    className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-danger group-hover:opacity-100 disabled:opacity-20"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                </Fragment>
              );
            })}
          </div>
          {bot ? <NewThreadButton bot={bot} onCreated={closeMenu} className="mt-1 w-full rounded-none border-t border-hairline/40" /> : <button
            type="button"
            onClick={() => {
              onNew();
              closeMenu();
            }}
            disabled={busy}
            className="mt-1 flex w-full items-center gap-2 border-t border-hairline/40 px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/50 disabled:opacity-40"
          >
            <Plus size={13} className="text-ink-secondary" /> {t("task.newShort")}
          </button>}
        </div>
      )}
    </div>
  );
}

export function BotActivityPicker({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  if (showThreads) return null;
  const activity = sidebarBotActivityTasks(bot, state.pendingQueued).filter((task) => task.threadId !== bot.threadId);
  // A display preference must not strand a sibling approval or queued job,
  // including on narrow screens where the sidebar is closed. This is an
  // activity switcher only: idle histories and creation remain hidden.
  if (!activity.length) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 px-5 py-2" data-background-activity>
      <select
        aria-label={t("task.otherActivity", { count: activity.length })}
        value=""
        onChange={(event) => dispatch({ type: "switchTask", botId: bot.id, threadId: event.target.value })}
        className="max-w-[180px] shrink-0 truncate rounded-full border border-hairline/40 bg-panel px-2.5 py-1 text-[12.5px] text-ink-secondary"
      >
        <option value="" disabled>{t("task.otherActivity", { count: activity.length })}</option>
        {activity.map((task) => <option key={task.threadId} value={task.threadId}>
          {task.title} · {task.activity === "waiting-on-you" ? t("task.waiting") : task.busy || task.activity === "working" ? t("chat.activity.working") : task.queued ? t("task.queued") : t("task.unread")}
        </option>)}
      </select>
      <span className="truncate text-[12px] text-ink-secondary">{bot.tasks?.find((task) => task.threadId === bot.threadId)?.title}</span>
    </div>
  );
}

export function TaskPicker({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const showThreads = useShowThreads();
  if (!showThreads) return null;
  return (
    <ConversationTaskPicker
      threadId={bot.threadId}
      tasks={(bot.tasks ?? []).filter((task) => !task.routineRunId)}
      busy={false}
      bot={bot}
      onNew={() => dispatch({ type: "newTask", botId: bot.id })}
      onSwitch={(threadId) => dispatch({ type: "switchTask", botId: bot.id, threadId })}
      onRename={(threadId, title) => dispatch({ type: "renameTask", botId: bot.id, threadId, title })}
      onDelete={(threadId) => dispatch({ type: "deleteTask", botId: bot.id, threadId })}
      onMove={(threadId, projectId) => dispatch({ type: "updateTask", botId: bot.id, threadId, patch: { projectId } })}
    />
  );
}

/** The same task affordance in a channel. DMs never render it because their
 * transcript is the private bot-to-bot exchange rather than user work. */
export function GroupTaskPicker({ group }: { group: Group }) {
  const { dispatch } = useStore();
  return (
    <ConversationTaskPicker
      threadId={group.threadId}
      tasks={group.tasks ?? []}
      busy={Boolean(group.working || group.busyBotId)}
      onNew={() => dispatch({ type: "newGroupTask", groupId: group.id })}
      onSwitch={(threadId) => dispatch({ type: "switchGroupTask", groupId: group.id, threadId })}
      onRename={(threadId, title) => dispatch({ type: "renameGroupTask", groupId: group.id, threadId, title })}
      onDelete={(threadId) => dispatch({ type: "deleteGroupTask", groupId: group.id, threadId })}
    />
  );
}
