import { useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import {
  AGENT_TASK_PRIORITIES,
  AGENT_TASK_TYPES,
  type AgentTask,
  type AgentTaskPriority,
  type AgentTaskType,
} from "../../../shared/work-tasks";
import { createWorkTask } from "./work-tasks-api";

export function NewTaskModal({
  roomId,
  members,
  existingTasks,
  onClose,
  onCreated,
}: {
  roomId: string;
  members: Bot[];
  existingTasks: AgentTask[];
  onClose: () => void;
  onCreated: (task: AgentTask) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<AgentTaskType>("task");
  const [priority, setPriority] = useState<AgentTaskPriority>("medium");
  const [assigneeBotId, setAssigneeBotId] = useState("");
  const [qaBotId, setQaBotId] = useState("");
  const [parentTaskId, setParentTaskId] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const acceptanceCriteria = criteriaText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const labels = labelsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const dueAt = dueDate ? new Date(`${dueDate}T23:59:59`).getTime() : undefined;
      const res = await createWorkTask({
        roomId,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        type,
        priority,
        ...(assigneeBotId ? { assigneeBotId } : {}),
        ...(qaBotId ? { qaBotId } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
        ...(labels.length ? { labels } : {}),
        ...(dueAt && Number.isFinite(dueAt) ? { dueAt } : {}),
      });
      onCreated(res.task);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-3 rounded-2xl border border-hairline bg-panel p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-ink">{t("workTasks.create.title")}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-secondary hover:bg-ink/[0.06]">
            <X size={16} />
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">{t("workTasks.create.taskTitle")}</span>
          <input
            type="text"
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("workTasks.create.titlePlaceholder")}
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
          />
        </label>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">{t("workTasks.create.description")}</span>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
          />
        </label>

        <div className="grid grid-cols-2 gap-2.5">
          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">{t("workTasks.field.type")}</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as AgentTaskType)}
              className="w-full rounded-lg border border-hairline bg-control px-2.5 py-1.5 text-ink"
            >
              {AGENT_TASK_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {t(`workTasks.type.${tp}` as any)}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">{t("workTasks.field.priority")}</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as AgentTaskPriority)}
              className="w-full rounded-lg border border-hairline bg-control px-2.5 py-1.5 text-ink"
            >
              {AGENT_TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`workTasks.priority.${p}` as any)}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">{t("workTasks.field.assignee")}</span>
            <select
              value={assigneeBotId}
              onChange={(e) => setAssigneeBotId(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-control px-2.5 py-1.5 text-ink"
            >
              <option value="">{t("workTasks.unassigned")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} {m.title ? `(${m.title})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">{t("workTasks.field.qa")}</span>
            <select
              value={qaBotId}
              onChange={(e) => setQaBotId(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-control px-2.5 py-1.5 text-ink"
            >
              <option value="">{t("workTasks.autoRole")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} {m.title ? `(${m.title})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">{t("workTasks.detail.parent")}</span>
            <select
              value={parentTaskId}
              onChange={(e) => setParentTaskId(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-control px-2.5 py-1.5 text-ink"
            >
              <option value="">{t("workTasks.none")}</option>
              {existingTasks.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.key} — {item.title}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">{t("workTasks.field.dueDate")}</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-2.5 py-1.5 text-ink"
            />
          </label>
        </div>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">{t("workTasks.detail.acceptanceCriteria")}</span>
          <textarea
            rows={2}
            value={criteriaText}
            onChange={(e) => setCriteriaText(e.target.value)}
            placeholder={t("workTasks.create.criteriaHint")}
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-ink"
          />
        </label>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">{t("workTasks.field.labels")}</span>
          <input
            type="text"
            value={labelsText}
            onChange={(e) => setLabelsText(e.target.value)}
            placeholder="backend, api, urgent"
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-ink"
          />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.06]"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-lg bg-ink px-4 py-1.5 text-[13px] font-medium text-app hover:opacity-90 disabled:opacity-50"
          >
            {t("workTasks.create.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

