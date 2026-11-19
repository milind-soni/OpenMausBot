import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckSquare,
  ExternalLink,
  FileText,
  GitCommit,
  Link2,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import {
  AGENT_TASK_PRIORITIES,
  AGENT_TASK_TYPES,
  WORK_TASK_TRANSITIONS,
  type AgentTask,
  type AgentTaskEvidenceType,
  type AgentTaskPriority,
  type AgentTaskStatus,
  type AgentTaskType,
  type TaskActivity,
} from "../../../shared/work-tasks";
import { BotAvatar } from "../Avatar";
import {
  addWorkTaskComment,
  addWorkTaskEvidence,
  createJiraForTask,
  createWorkTask,
  deleteWorkTask,
  fetchWorkTaskDetail,
  linkJiraToTask,
  syncJiraForTask,
  updateWorkTask,
} from "./work-tasks-api";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TaskDetailDrawer({
  taskId,
  allTasks,
  members,
  jiraEnabled,
  onClose,
  onOpenTask,
  onOpenThread,
  onTaskUpdated,
}: {
  taskId: string;
  allTasks: AgentTask[];
  members: Bot[];
  jiraEnabled: boolean;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenThread: (task: AgentTask) => void;
  onTaskUpdated: () => void;
}) {
  const [task, setTask] = useState<AgentTask | null>(null);
  const [subtasks, setSubtasks] = useState<AgentTask[]>([]);
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [commentText, setCommentText] = useState("");
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [newCriteria, setNewCriteria] = useState("");
  const [evType, setEvType] = useState<AgentTaskEvidenceType>("test");
  const [evLabel, setEvLabel] = useState("");
  const [evValue, setEvValue] = useState("");
  const [jiraLinkInput, setJiraLinkInput] = useState("");
  const [depInput, setDepInput] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const detail = await fetchWorkTaskDetail(taskId);
      setTask(detail.task);
      setSubtasks(detail.subtasks);
      setActivities(detail.activities);
      setDescDraft(detail.task.description ?? "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const handlePatch = async (patch: Parameters<typeof updateWorkTask>[1]) => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      await updateWorkTask(task.id, patch);
      await load();
      onTaskUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAddComment = async () => {
    if (!task || !commentText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addWorkTaskComment(task.id, commentText.trim());
      setCommentText("");
      await load();
      onTaskUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAddEvidence = async () => {
    if (!task || !evLabel.trim() || !evValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addWorkTaskEvidence(task.id, {
        type: evType,
        label: evLabel.trim(),
        value: evValue.trim(),
      });
      setEvLabel("");
      setEvValue("");
      await load();
      onTaskUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateSubtask = async () => {
    if (!task || !newSubtaskTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createWorkTask({
        roomId: task.roomId,
        parentTaskId: task.id,
        type: "subtask",
        title: newSubtaskTitle.trim(),
        priority: task.priority,
      });
      setNewSubtaskTitle("");
      await load();
      onTaskUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    setBusy(true);
    try {
      await deleteWorkTask(task.id);
      onTaskUpdated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const memberMap = new Map(members.map((m) => [m.id, m]));
  const allowedNext = task ? [task.status, ...(WORK_TASK_TRANSITIONS[task.status] ?? [])] : [];
  const jiraLink = task?.externalLinks?.find((l) => l.provider === "jira");
  const jiraKey = task?.jiraSync?.issueKey ?? jiraLink?.key;

  return (
    <div
      role="dialog"
      aria-label={task ? `${task.key} ${task.title}` : t("workTasks.detail.loading")}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[540px] flex-col border-l border-edge bg-panel shadow-xl"
    >
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {task && (
            <span className="rounded bg-raised px-2 py-0.5 font-mono text-[12px] font-semibold text-ink">
              {task.key}
            </span>
          )}
          {task?.parentTaskId && (
            <button
              type="button"
              onClick={() => onOpenTask(task.parentTaskId!)}
              className="truncate text-[12px] text-accent-text hover:underline"
            >
              ↑ {allTasks.find((t) => t.id === task.parentTaskId)?.key ?? t("workTasks.detail.parent")}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {task?.threadId && (
            <button
              type="button"
              onClick={() => onOpenThread(task)}
              className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover"
            >
              <MessageSquare size={13} />
              <span>{t("workTasks.detail.openThread")}</span>
            </button>
          )}
          {task && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              title={t("workTasks.detail.delete")}
              aria-label={t("workTasks.detail.delete")}
              className="rounded-lg p-1.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-danger"
            >
              <Trash2 size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {loading || !task ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary">
          {t("workTasks.detail.loading")}
        </div>
      ) : (
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {task.needsUserAction && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-ink">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
              <div className="flex-1">
                <div className="font-semibold text-warning">{t("workTasks.card.needsUser")}</div>
                {task.needsUserReason && <div className="mt-0.5 text-ink-secondary">{task.needsUserReason}</div>}
              </div>
            </div>
          )}

          {/* Title & Description */}
          <div>
            <h2 className="text-[17px] font-semibold leading-snug text-ink">{task.title}</h2>
            {editingDesc ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink focus:border-focus focus:outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingDesc(false)}
                    className="rounded-lg px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-ink/[0.06]"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      await handlePatch({ description: descDraft });
                      setEditingDesc(false);
                    }}
                    className="rounded-lg bg-ink px-3 py-1 text-[12px] font-medium text-app hover:opacity-90"
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            ) : (
              <div
                onClick={() => setEditingDesc(true)}
                className="mt-2 cursor-pointer rounded-lg border border-transparent px-2 py-1.5 text-[13px] whitespace-pre-wrap text-ink-secondary hover:border-hairline hover:bg-card"
              >
                {task.description || t("workTasks.detail.addDescription")}
              </div>
            )}
          </div>

          {/* Core metadata grid */}
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-hairline bg-card p-3 text-[12px]">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-ink-tertiary">{t("workTasks.field.status")}</span>
              <select
                value={task.status}
                disabled={busy}
                onChange={(e) => void handlePatch({ status: e.target.value as AgentTaskStatus })}
                className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
              >
                {allowedNext.map((s) => (
                  <option key={s} value={s}>
                    {t(`workTasks.status.${s}` as any)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-ink-tertiary">{t("workTasks.field.priority")}</span>
              <select
                value={task.priority}
                disabled={busy}
                onChange={(e) => void handlePatch({ priority: e.target.value as AgentTaskPriority })}
                className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
              >
                {AGENT_TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`workTasks.priority.${p}` as any)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-ink-tertiary">{t("workTasks.field.assignee")}</span>
              <select
                value={task.assigneeBotId ?? ""}
                disabled={busy}
                onChange={(e) =>
                  void handlePatch({ assigneeBotId: e.target.value ? e.target.value : null })
                }
                className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
              >
                <option value="">{t("workTasks.unassigned")}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.title ? `(${m.title})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-ink-tertiary">{t("workTasks.field.qa")}</span>
              <select
                value={task.qaBotId ?? ""}
                disabled={busy}
                onChange={(e) => void handlePatch({ qaBotId: e.target.value ? e.target.value : null })}
                className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
              >
                <option value="">{t("workTasks.autoRole")}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.title ? `(${m.title})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-ink-tertiary">{t("workTasks.field.type")}</span>
              <select
                value={task.type}
                disabled={busy}
                onChange={(e) => void handlePatch({ type: e.target.value as AgentTaskType })}
                className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
              >
                {AGENT_TASK_TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {t(`workTasks.type.${tp}` as any)}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-ink-tertiary">{t("workTasks.field.coordinator")}</span>
              <div className="flex items-center gap-1.5 py-1 text-ink">
                {task.coordinatorBotId && memberMap.get(task.coordinatorBotId) ? (
                  <>
                    <BotAvatar
                      bot={memberMap.get(task.coordinatorBotId)!}
                      state="happy"
                      size={16}
                      animated={false}
                    />
                    <span className="truncate">{memberMap.get(task.coordinatorBotId)!.name}</span>
                  </>
                ) : (
                  <span className="text-ink-secondary">{task.coordinatorBotId ?? "—"}</span>
                )}
              </div>
            </div>
          </div>

          {/* Acceptance Criteria */}
          <section className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-tertiary">
              {t("workTasks.detail.acceptanceCriteria")}
            </h3>
            <ul className="space-y-1">
              {(task.acceptanceCriteria ?? []).map((item, idx) => (
                <li key={idx} className="flex items-start justify-between gap-2 rounded-lg bg-card px-2.5 py-1.5 text-[12px] text-ink">
                  <span className="flex items-start gap-1.5">
                    <CheckSquare size={13} className="mt-0.5 shrink-0 text-accent-text" />
                    <span>{item}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void handlePatch({
                        acceptanceCriteria: (task.acceptanceCriteria ?? []).filter((_, i) => i !== idx),
                      })
                    }
                    className="text-ink-tertiary hover:text-danger"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={newCriteria}
                onChange={(e) => setNewCriteria(e.target.value)}
                placeholder={t("workTasks.detail.addCriteriaPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newCriteria.trim()) {
                    void handlePatch({
                      acceptanceCriteria: [...(task.acceptanceCriteria ?? []), newCriteria.trim()],
                    });
                    setNewCriteria("");
                  }
                }}
                className="flex-1 rounded-lg border border-hairline bg-inset px-2.5 py-1 text-[12px] text-ink"
              />
              <button
                type="button"
                onClick={() => {
                  if (!newCriteria.trim()) return;
                  void handlePatch({
                    acceptanceCriteria: [...(task.acceptanceCriteria ?? []), newCriteria.trim()],
                  });
                  setNewCriteria("");
                }}
                className="rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
              >
                <Plus size={13} />
              </button>
            </div>
          </section>

          {/* Subtasks */}
          <section className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-tertiary">
              {t("workTasks.detail.subtasks")} ({subtasks.length})
            </h3>
            {subtasks.length > 0 && (
              <div className="space-y-1">
                {subtasks.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => onOpenTask(sub.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-hairline bg-card px-2.5 py-1.5 text-left text-[12px] hover:bg-raised-hover"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-[11px] text-ink-tertiary">{sub.key}</span>
                      <span className="truncate text-ink">{sub.title}</span>
                    </span>
                    <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-secondary">
                      {t(`workTasks.status.${sub.status}` as any)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <input
                type="text"
                value={newSubtaskTitle}
                onChange={(e) => setNewSubtaskTitle(e.target.value)}
                placeholder={t("workTasks.detail.addSubtaskPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateSubtask();
                }}
                className="flex-1 rounded-lg border border-hairline bg-inset px-2.5 py-1 text-[12px] text-ink"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleCreateSubtask()}
                className="rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
              >
                <Plus size={13} />
              </button>
            </div>
          </section>

          {/* Dependencies */}
          <section className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-tertiary">
              {t("workTasks.detail.dependencies")} ({task.dependencies?.length ?? 0})
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {(task.dependencies ?? []).map((depId) => {
                const depTask = allTasks.find((t) => t.id === depId || t.key === depId);
                return (
                  <span
                    key={depId}
                    className="inline-flex items-center gap-1 rounded-full border border-hairline bg-card px-2 py-0.5 text-[11px] text-ink"
                  >
                    <button type="button" onClick={() => depTask && onOpenTask(depTask.id)} className="hover:underline">
                      {depTask ? `${depTask.key} (${t(`workTasks.status.${depTask.status}` as any)})` : depId}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handlePatch({
                          dependencies: (task.dependencies ?? []).filter((d) => d !== depId),
                        })
                      }
                      className="text-ink-tertiary hover:text-danger"
                    >
                      <X size={11} />
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="flex gap-1.5">
              <select
                value={depInput}
                onChange={(e) => setDepInput(e.target.value)}
                className="flex-1 rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
              >
                <option value="">{t("workTasks.detail.selectDependency")}</option>
                {allTasks
                  .filter((candidate) => candidate.id !== task.id && !(task.dependencies ?? []).includes(candidate.id))
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.key} — {candidate.title}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  if (!depInput) return;
                  void handlePatch({ dependencies: [...(task.dependencies ?? []), depInput] });
                  setDepInput("");
                }}
                className="rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
              >
                <Plus size={13} />
              </button>
            </div>
          </section>

          {/* Evidence */}
          <section className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-tertiary">
              {t("workTasks.detail.evidence")} ({task.evidence?.length ?? 0})
            </h3>
            <div className="space-y-1.5">
              {(task.evidence ?? []).map((ev) => (
                <div key={ev.id} className="flex items-start gap-2 rounded-lg border border-hairline bg-card px-2.5 py-2 text-[12px]">
                  {ev.type === "commit" ? (
                    <GitCommit size={14} className="mt-0.5 shrink-0 text-accent-text" />
                  ) : ev.type === "url" ? (
                    <Link2 size={14} className="mt-0.5 shrink-0 text-accent-text" />
                  ) : (
                    <FileText size={14} className="mt-0.5 shrink-0 text-ink-secondary" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-secondary">
                        {ev.type}
                      </span>
                      <span className="font-medium text-ink">{ev.label}</span>
                    </div>
                    <div className="mt-0.5 break-all font-mono text-[11px] text-ink-secondary">{ev.value}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-[90px_1fr] gap-1.5">
              <select
                value={evType}
                onChange={(e) => setEvType(e.target.value as AgentTaskEvidenceType)}
                className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
              >
                <option value="test">Test</option>
                <option value="commit">Commit</option>
                <option value="file">File</option>
                <option value="url">URL</option>
                <option value="message">Note</option>
              </select>
              <input
                type="text"
                value={evLabel}
                onChange={(e) => setEvLabel(e.target.value)}
                placeholder={t("workTasks.detail.evidenceLabel")}
                className="rounded-lg border border-hairline bg-inset px-2.5 py-1 text-[12px] text-ink"
              />
              <input
                type="text"
                value={evValue}
                onChange={(e) => setEvValue(e.target.value)}
                placeholder={t("workTasks.detail.evidenceValue")}
                className="col-span-2 rounded-lg border border-hairline bg-inset px-2.5 py-1 font-mono text-[12px] text-ink"
              />
              <button
                type="button"
                disabled={busy || !evLabel.trim() || !evValue.trim()}
                onClick={() => void handleAddEvidence()}
                className="col-span-2 rounded-lg border border-hairline bg-control px-3 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {t("workTasks.detail.addEvidence")}
              </button>
            </div>
          </section>

          {/* Jira Integration */}
          <section className="space-y-2 rounded-xl border border-hairline bg-card p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-tertiary">
                Jira
              </h3>
              {task.jiraSync?.lastSyncedAt && (
                <span className="text-[11px] text-ink-tertiary">
                  {t("workTasks.jira.lastSynced")}: {formatDateTime(task.jiraSync.lastSyncedAt)}
                </span>
              )}
            </div>
            {task.jiraSync?.lastError && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
                <span className="truncate">{task.jiraSync.lastError}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await syncJiraForTask(task.id);
                    await load();
                    onTaskUpdated();
                    setBusy(false);
                  }}
                  className="shrink-0 font-semibold underline"
                >
                  {t("workTasks.jira.retry")}
                </button>
              </div>
            )}
            {jiraKey ? (
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <a
                  href={jiraLink?.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono font-medium text-accent-text hover:underline"
                >
                  <span>{jiraKey}</span>
                  <ExternalLink size={12} />
                </a>
                <button
                  type="button"
                  disabled={busy || !jiraEnabled}
                  onClick={async () => {
                    setBusy(true);
                    const res = await syncJiraForTask(task.id);
                    if (!res.ok && res.error) setError(res.error);
                    await load();
                    onTaskUpdated();
                    setBusy(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-control px-2.5 py-1 text-[11px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  <RefreshCw size={11} />
                  <span>{t("workTasks.jira.syncNow")}</span>
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={jiraLinkInput}
                    onChange={(e) => setJiraLinkInput(e.target.value)}
                    placeholder="PROJ-123"
                    className="flex-1 rounded-lg border border-hairline bg-inset px-2.5 py-1 font-mono text-[12px] text-ink"
                  />
                  <button
                    type="button"
                    disabled={busy || !jiraLinkInput.trim()}
                    onClick={async () => {
                      setBusy(true);
                      const res = await linkJiraToTask(task.id, jiraLinkInput.trim());
                      if (!res.ok && res.error) setError(res.error);
                      setJiraLinkInput("");
                      await load();
                      onTaskUpdated();
                      setBusy(false);
                    }}
                    className="rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    {t("workTasks.jira.link")}
                  </button>
                </div>
                {jiraEnabled && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const res = await createJiraForTask(task.id);
                      if (!res.ok && res.error) setError(res.error);
                      await load();
                      onTaskUpdated();
                      setBusy(false);
                    }}
                    className="w-full rounded-lg border border-hairline bg-control px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover"
                  >
                    {t("workTasks.jira.createIssue")}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Activity History & Comments */}
          <section className="space-y-2.5">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-tertiary">
              {t("workTasks.detail.activity")}
            </h3>
            <div className="space-y-2">
              {activities.map((act) => (
                <div key={act.id} className="flex items-start gap-2 text-[12px]">
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-tertiary">
                    {formatTime(act.createdAt)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-ink">
                      {act.actorName || act.actorType}
                      {act.actorRole ? ` (${act.actorRole})` : ""}
                    </span>
                    <span className="text-ink-secondary"> — {act.message}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 pt-1">
              <input
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder={t("workTasks.detail.commentPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAddComment();
                }}
                className="flex-1 rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[12px] text-ink"
              />
              <button
                type="button"
                disabled={busy || !commentText.trim()}
                onClick={() => void handleAddComment()}
                className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-50"
              >
                <Send size={12} />
                <span>{t("workTasks.detail.commentSend")}</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
