/** Client-safe progress projection for one temporary worker batch.
 * Deliberately excludes prompts, results, errors, and worker transcripts. */

export type WorkerBatchJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export interface WorkerBatchCounts {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  canceled: number;
}

export type WorkerBatchLifecycle =
  | { status: "queued"; terminal: false }
  | { status: "running"; terminal: false }
  | { status: "completed"; terminal: true }
  | { status: "failed"; terminal: true }
  | { status: "canceled"; terminal: true };

export interface WorkerBatchJobProjection {
  id: string;
  label: string;
  status: WorkerBatchJobStatus;
  waitingReason?: string;
}

export type WorkerBatchProjection = WorkerBatchLifecycle & {
  id: string;
  taskId: string;
  label: string;
  jobs: WorkerBatchJobProjection[];
  counts: WorkerBatchCounts;
  createdAt: number;
  updatedAt: number;
};
