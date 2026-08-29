import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "./schema.ts";
import type {
  WorkerBatchCounts,
  WorkerBatchJobProjection,
  WorkerBatchLifecycle,
  WorkerBatchProjection,
} from "../shared/worker-batch.ts";

export type {
  WorkerBatchCounts,
  WorkerBatchJobProjection,
  WorkerBatchLifecycle,
  WorkerBatchProjection,
} from "../shared/worker-batch.ts";

export const DEFAULT_WORKER_CONCURRENCY = 8;
export const HARD_WORKER_CONCURRENCY_CAP = 8;

export type WorkerJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
/** A job may cross a process restart only when its owner has explicitly
 * classified replay as safe. Absence is deliberately not permissive: a
 * queued provider job can still have an externally visible effect if an
 * earlier process accepted it before persisting its state. */
export type WorkerJobResumePolicy = "safe" | "never";

export interface WorkerJobRequest {
  /** Stable request-local identity used by dependency edges. */
  key?: string;
  prompt: string;
  label?: string;
  /** All jobs launched together share this opaque grouping key. */
  batchId?: string;
  /** User-facing batch label; never contains worker transcripts. */
  batchLabel?: string;
  metadata?: JsonObject;
  resumePolicy?: WorkerJobResumePolicy;
  dependsOn?: readonly string[];
  resourceLocks?: readonly string[];
  approvalGate?: string;
}

export interface WorkerJobRecord extends WorkerJobRequest {
  id: string;
  taskId: string;
  hidden: true;
  status: WorkerJobStatus;
  resumePolicy?: WorkerJobResumePolicy;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  result?: JsonValue;
  error?: string;
  waitReason?: string;
}

export interface WorkerJobStore {
  create: (job: WorkerJobRecord) => void | Promise<void>;
  update: (id: string, patch: Partial<WorkerJobRecord>) => void | Promise<void>;
  list: () => readonly WorkerJobRecord[] | Promise<readonly WorkerJobRecord[]>;
  /** Flush a durable snapshot when the host is about to hand off. */
  checkpoint?: () => void | Promise<void>;
}

export interface WorkerJobDependencies {
  store: WorkerJobStore;
  run: (job: Readonly<WorkerJobRecord>) => JsonValue | undefined | Promise<JsonValue | undefined>;
  interrupt: (job: Readonly<WorkerJobRecord>) => void | Promise<void>;
  createId?: () => string;
  now?: () => number;
}

export interface WorkerJobsOptions {
  concurrency?: number;
}

export interface WorkerJobBatch {
  batchId: string;
  jobs: WorkerJobRecord[];
  projection: () => WorkerBatchProjection;
  settled: Promise<WorkerJobRecord[]>;
}

export type WorkerBatchListener = (projection: WorkerBatchProjection) => void;

export interface WorkerBatchOptions {
  id?: string;
  label?: string;
}

export interface WorkerJobs {
  launchBatch(taskId: string, requests: readonly WorkerJobRequest[], options?: WorkerBatchOptions): Promise<WorkerJobBatch>;
  cancelTask(taskId: string): Promise<number>;
  checkpoint(): Promise<WorkerJobRecord[]>;
  recover(): Promise<WorkerJobBatch>;
  snapshot(taskId?: string): WorkerJobRecord[];
  batchSnapshot(taskId?: string): WorkerBatchProjection[];
  subscribe(listener: WorkerBatchListener): () => void;
}

interface RuntimeJob {
  record: WorkerJobRecord;
  resolve: (record: WorkerJobRecord) => void;
  settled: Promise<WorkerJobRecord>;
  isSettled: boolean;
}

export function createWorkerJobs(
  dependencies: WorkerJobDependencies,
  options: WorkerJobsOptions = {},
): WorkerJobs {
  return new WorkerJobController(dependencies, options);
}

class WorkerJobController implements WorkerJobs {
  private dependencies: WorkerJobDependencies;
  private concurrency: number;
  private jobs = new Map<string, RuntimeJob>();
  private queue: string[] = [];
  private active = 0;
  private readonly heldLocks = new Map<string, number>();
  private listeners = new Set<WorkerBatchListener>();

  constructor(dependencies: WorkerJobDependencies, options: WorkerJobsOptions) {
    this.dependencies = dependencies;
    const requested = Math.trunc(options.concurrency ?? DEFAULT_WORKER_CONCURRENCY);
    this.concurrency = Math.max(1, Math.min(HARD_WORKER_CONCURRENCY_CAP, requested));
  }

  async launchBatch(taskId: string, requests: readonly WorkerJobRequest[], options: WorkerBatchOptions = {}): Promise<WorkerJobBatch> {
    const batchId = options.id ?? randomUUID();
    const batchLabel = options.label?.trim() || "Parallel work";
    const runtimes: RuntimeJob[] = [];
    for (const request of requests) {
      const runtime = this.makeRuntime({
        ...request,
        id: this.dependencies.createId?.() ?? randomUUID(),
        taskId,
        batchId,
        batchLabel,
        hidden: true,
        status: "queued",
        createdAt: this.now(),
      });
      await this.dependencies.store.create(runtime.record);
      this.jobs.set(runtime.record.id, runtime);
      this.queue.push(runtime.record.id);
      runtimes.push(runtime);
    }
    this.emitBatch(batchId);
    this.pump();
    return {
      batchId,
      jobs: runtimes.map((runtime) => structuredClone(runtime.record)),
      settled: Promise.all(runtimes.map((runtime) => runtime.settled)),
      projection: () => {
        const projection = this.batchSnapshot().find((batch) => batch.id === batchId);
        if (!projection) throw new Error("worker batch is no longer available");
        return projection;
      },
    };
  }

  async cancelTask(taskId: string): Promise<number> {
    const targets = [...this.jobs.values()].filter(
      (runtime) => runtime.record.taskId === taskId && !runtime.isSettled,
    );
    let canceled = 0;
    await Promise.all(targets.map(async (runtime) => {
      const wasRunning = runtime.record.status === "running";
      if (await this.settle(runtime, "canceled", {})) canceled += 1;
      if (!wasRunning) return;
      try {
        await this.dependencies.interrupt(structuredClone(runtime.record));
      } catch {
        // The durable cancellation already won the settle race. A provider
        // that has disappeared cannot turn the job back into a failure.
      }
    }));
    this.pump();
    return canceled;
  }

  async checkpoint(): Promise<WorkerJobRecord[]> {
    await this.dependencies.store.checkpoint?.();
    return this.snapshot();
  }

  async recover(): Promise<WorkerJobBatch> {
    const runtimes: RuntimeJob[] = [];
    const persisted = await this.dependencies.store.list();
    for (const job of persisted) {
      if (job.status !== "queued" && job.status !== "running") continue;
      if (this.jobs.has(job.id)) continue;
      if (job.status === "running") {
        const failed: WorkerJobRecord = {
          ...job,
          status: "failed",
          settledAt: this.now(),
          error: "interrupted by restart; not replayed",
        };
        await this.dependencies.store.update(job.id, {
          status: failed.status,
          settledAt: failed.settledAt,
          error: failed.error,
        });
        this.rememberTerminal(failed);
        continue;
      }
      if (job.resumePolicy !== "safe") {
        const failed: WorkerJobRecord = {
          ...job,
          status: "failed",
          settledAt: this.now(),
          error: "queued job was not explicitly marked safe to resume; not replayed",
        };
        await this.dependencies.store.update(job.id, {
          status: failed.status,
          settledAt: failed.settledAt,
          error: failed.error,
        });
        this.rememberTerminal(failed);
        continue;
      }
      const record: WorkerJobRecord = {
        ...job,
        hidden: true,
        status: "queued",
        startedAt: undefined,
        settledAt: undefined,
        result: undefined,
        error: undefined,
      };
      const runtime = this.makeRuntime(record);
      await this.dependencies.store.update(record.id, {
        hidden: true,
        status: "queued",
        startedAt: undefined,
        settledAt: undefined,
        result: undefined,
        error: undefined,
      });
      this.jobs.set(record.id, runtime);
      this.queue.push(record.id);
      runtimes.push(runtime);
    }
    this.pump();
    return {
      batchId: runtimes[0]?.record.batchId ?? randomUUID(),
      jobs: runtimes.map((runtime) => structuredClone(runtime.record)),
      settled: Promise.all(runtimes.map((runtime) => runtime.settled)),
      projection: () => {
        const batchId = runtimes[0]?.record.batchId;
        const projection = batchId ? this.batchSnapshot().find((batch) => batch.id === batchId) : undefined;
        if (!projection) throw new Error("worker batch is no longer available");
        return projection;
      },
    };
  }

  snapshot(taskId?: string): WorkerJobRecord[] {
    return [...this.jobs.values()]
      .map((runtime) => runtime.record)
      .filter((job) => taskId === undefined || job.taskId === taskId)
      .map((job) => structuredClone(job));
  }

  batchSnapshot(taskId?: string): WorkerBatchProjection[] {
    const grouped = new Map<string, WorkerJobRecord[]>();
    for (const runtime of this.jobs.values()) {
      const job = runtime.record;
      if (taskId !== undefined && job.taskId !== taskId) continue;
      const batchId = job.batchId ?? job.id;
      const jobs = grouped.get(batchId);
      if (jobs) jobs.push(job);
      else grouped.set(batchId, [job]);
    }
    return [...grouped.entries()].map(([id, jobs]) => makeBatchProjection(id, jobs));
  }

  subscribe(listener: WorkerBatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private makeRuntime(record: WorkerJobRecord): RuntimeJob {
    let resolve!: (record: WorkerJobRecord) => void;
    const settled = new Promise<WorkerJobRecord>((done) => {
      resolve = done;
    });
    return { record, resolve, settled, isSettled: false };
  }

  private pump(): void {
    this.failBlockedDependents();
    while (this.active < this.concurrency) {
      const index = this.queue.findIndex((id) => {
        const runtime = this.jobs.get(id);
        if (!runtime || runtime.isSettled) return false;
        const reason = this.waitReason(runtime.record);
        if (reason) {
          if (runtime.record.waitReason !== reason) {
            runtime.record = { ...runtime.record, waitReason: reason };
            void this.dependencies.store.update(runtime.record.id, { waitReason: reason });
          }
          return false;
        }
        if (runtime.record.waitReason !== undefined) {
          runtime.record = { ...runtime.record, waitReason: undefined };
          void this.dependencies.store.update(runtime.record.id, { waitReason: undefined });
        }
        return true;
      });
      if (index < 0) return;
      const [id] = this.queue.splice(index, 1);
      if (!id) return;
      const runtime = this.jobs.get(id);
      if (!runtime || runtime.isSettled) continue;
      for (const lock of runtime.record.resourceLocks ?? []) {
        this.heldLocks.set(lock, (this.heldLocks.get(lock) ?? 0) + 1);
      }
      this.active += 1;
      void this.execute(runtime);
    }
  }

  private async execute(runtime: RuntimeJob): Promise<void> {
    try {
      runtime.record = {
        ...runtime.record,
        status: "running",
        startedAt: this.now(),
      };
      await this.dependencies.store.update(runtime.record.id, {
        status: "running",
        startedAt: runtime.record.startedAt,
      });
      this.emitBatch(runtime.record.batchId);
      const result = await this.dependencies.run(structuredClone(runtime.record));
      await this.settle(runtime, "completed", { result });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Worker failed with a non-Error rejection";
      await this.settle(runtime, "failed", { error: message });
    } finally {
      for (const lock of runtime.record.resourceLocks ?? []) {
        const holders = this.heldLocks.get(lock) ?? 0;
        if (holders <= 1) this.heldLocks.delete(lock);
        else this.heldLocks.set(lock, holders - 1);
      }
      this.active -= 1;
      this.pump();
    }
  }

  private async settle(
    runtime: RuntimeJob,
    status: Extract<WorkerJobStatus, "completed" | "failed" | "canceled">,
    details: Partial<Pick<WorkerJobRecord, "result" | "error">>,
  ): Promise<boolean> {
    if (runtime.isSettled) return false;
    runtime.isSettled = true;
    runtime.record = {
      ...runtime.record,
      ...details,
      status,
      settledAt: this.now(),
      waitReason: undefined,
    };
    await this.dependencies.store.update(runtime.record.id, {
      ...details,
      status,
      settledAt: runtime.record.settledAt,
    });
    this.emitBatch(runtime.record.batchId);
    runtime.resolve(structuredClone(runtime.record));
    return true;
  }

  private waitReason(record: WorkerJobRecord): string | undefined {
    for (const dependency of record.dependsOn ?? []) {
      const prerequisite = [...this.jobs.values()].find((candidate) => candidate.record.id === dependency || candidate.record.key === dependency)?.record;
      if (!prerequisite) return `Waiting for prerequisite ${dependency}`;
      if (prerequisite.status === "failed" || prerequisite.status === "canceled") return `Prerequisite ${dependency} did not complete`;
      if (prerequisite.status !== "completed") return `Waiting for prerequisite ${dependency}`;
    }
    if (record.approvalGate) return `Waiting for approval: ${record.approvalGate}`;
    const held = record.resourceLocks?.find((lock) => this.heldLocks.has(lock));
    return held ? `Waiting for shared resource ${held}` : undefined;
  }

  private failBlockedDependents(): void {
    for (const id of this.queue) {
      const runtime = this.jobs.get(id);
      if (!runtime || runtime.isSettled) continue;
      const failed = (runtime.record.dependsOn ?? []).find((dependency) => {
        const prerequisite = [...this.jobs.values()].find((candidate) => candidate.record.id === dependency || candidate.record.key === dependency)?.record;
        return prerequisite?.status === "failed" || prerequisite?.status === "canceled";
      });
      if (failed) void this.settle(runtime, "failed", { error: `prerequisite ${failed} did not complete` });
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private emitBatch(batchId: string | undefined): void {
    if (!batchId) return;
    const projection = this.batchSnapshot().find((batch) => batch.id === batchId);
    if (!projection) return;
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(projection));
      } catch {
        // Observability/UI subscribers must never change worker outcomes.
      }
    }
  }

  private rememberTerminal(record: WorkerJobRecord): void {
    const runtime = this.makeRuntime(record);
    runtime.isSettled = true;
    this.jobs.set(record.id, runtime);
    this.emitBatch(record.batchId);
  }
}

function makeBatchProjection(id: string, jobs: readonly WorkerJobRecord[]): WorkerBatchProjection {
  const counts: WorkerBatchCounts = {
    total: jobs.length,
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    canceled: jobs.filter((job) => job.status === "canceled").length,
  };
  const terminalCount = counts.completed + counts.failed + counts.canceled;
  const lifecycle: WorkerBatchLifecycle = counts.queued === counts.total
    ? { status: "queued", terminal: false }
    : terminalCount < counts.total
      ? { status: "running", terminal: false }
      : counts.failed > 0
        ? { status: "failed", terminal: true }
        : counts.canceled > 0
          ? { status: "canceled", terminal: true }
          : { status: "completed", terminal: true };
  const first = jobs[0];
  const updatedAt = Math.max(...jobs.map((job) => job.settledAt ?? job.startedAt ?? job.createdAt));
  return {
    id,
    taskId: first?.taskId ?? "",
    label: first?.batchLabel ?? first?.label ?? "Parallel work",
    jobs: jobs.map((job) => {
      const projection: WorkerBatchJobProjection = { id: job.id, label: job.label?.trim() || "Worker", status: job.status };
      if (job.waitReason) projection.waitingReason = job.waitReason;
      return projection;
    }),
    counts,
    createdAt: Math.min(...jobs.map((job) => job.createdAt)),
    updatedAt,
    ...lifecycle,
  };
}
