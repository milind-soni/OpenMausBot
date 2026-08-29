import type { WorkerBatchProjection } from "../../shared/worker-batch";

/** One honest, compact status line for the chat-native worker receipt. */
export function workerBatchSummary(batch: WorkerBatchProjection): string {
  const { counts } = batch;
  if (batch.status === "queued") {
    return `${counts.total} ${counts.total === 1 ? "worker" : "workers"} queued`;
  }
  if (batch.status === "running") {
    if (counts.completed > 0) return `${counts.completed} of ${counts.total} complete`;
    return `${counts.running} of ${counts.total} working`;
  }
  if (batch.status === "completed") {
    return `${counts.total} ${counts.total === 1 ? "worker" : "workers"} · Done`;
  }
  if (batch.status === "failed") {
    return `${counts.completed} done · ${counts.failed} failed`;
  }
  const pieces = ["Stopped"];
  if (counts.completed > 0) pieces.push(`${counts.completed} completed`);
  if (counts.canceled > 0) pieces.push(`${counts.canceled} canceled`);
  return pieces.join(" · ");
}
