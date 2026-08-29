import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { WorkerJobRecord, WorkerJobStore } from "./worker-jobs.ts";

const MAX_TERMINAL_RECORDS = 200;
const workerJobRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  prompt: z.string(),
  key: z.string().optional(),
  label: z.string().optional(),
  batchId: z.string().optional(),
  batchLabel: z.string().optional(),
  metadata: z.record(z.string(), z.json()).optional(),
  hidden: z.literal(true),
  status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
  resumePolicy: z.enum(["safe", "never"]).optional(),
  dependsOn: z.array(z.string()).optional(),
  resourceLocks: z.array(z.string()).optional(),
  approvalGate: z.string().optional(),
  waitReason: z.string().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  settledAt: z.number().optional(),
  result: z.json().optional(),
  error: z.string().optional(),
});

/** Durable adapter for the worker-job module. Open jobs are retained until
 * they settle; recent terminal receipts are bounded so unattended use cannot
 * grow this file forever. */
export function createWorkerJobFileStore(path: string): WorkerJobStore {
  const records = new Map<string, WorkerJobRecord>();
  if (existsSync(path)) {
    try {
      const parsed = z.array(workerJobRecordSchema).safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        for (const value of parsed.data) records.set(value.id, value);
      }
    } catch {
      // A corrupt optional receipt file must not prevent the assistant from
      // starting. New writes replace it atomically with valid state.
    }
  }

  const save = () => {
    const all = [...records.values()];
    const open = all.filter((job) => job.status === "queued" || job.status === "running");
    const terminal = all
      .filter((job) => job.status !== "queued" && job.status !== "running")
      .sort((a, b) => (b.settledAt ?? b.createdAt) - (a.settledAt ?? a.createdAt))
      .slice(0, MAX_TERMINAL_RECORDS);
    const retained = [...open, ...terminal];
    records.clear();
    for (const record of retained) records.set(record.id, record);
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, JSON.stringify(retained, null, 2), { mode: 0o600 });
  };

  return {
    create(job) {
      records.set(job.id, structuredClone(job));
      save();
    },
    update(id, patch) {
      const current = records.get(id);
      if (!current) throw new Error(`missing worker job ${id}`);
      records.set(id, { ...current, ...structuredClone(patch) });
      save();
    },
    list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    checkpoint() {
      save();
    },
  };
}
