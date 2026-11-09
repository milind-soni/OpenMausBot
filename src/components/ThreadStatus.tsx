import type { Task } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

type StatusTask = Pick<Task, "activity" | "busy" | "waitingForTeammates" | "closedBy" | "archivedAt">;

export function threadStatus(task: StatusTask, queued = false): "waitingForYou" | "waitingForTeammate" | "working" | "queued" | "completed" | "idle" {
  if (task.activity === "waiting-on-you") return "waitingForYou";
  if (task.waitingForTeammates) return "waitingForTeammate";
  if (task.busy || task.activity === "working") return "working";
  if (queued) return "queued";
  if (task.closedBy || task.archivedAt !== undefined) return "completed";
  return "idle";
}

export function ThreadStatus({ task, queued = false }: { task: StatusTask; queued?: boolean }) {
  const status = threadStatus(task, queued);
  return <span data-thread-status={status} className={cn("shrink-0 text-[11px]", status === "working" ? "text-success" : status === "waitingForYou" || status === "waitingForTeammate" ? "text-warning" : "text-ink-secondary")}>
    {t(`thread.status.${status}`)}
  </span>;
}
