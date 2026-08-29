import type { WorkerBatchProjection } from "../../shared/worker-batch";
import { WorkerBatchCard } from "@/components/WorkerBatchCard";

const active: WorkerBatchProjection = {
  id: "active",
  taskId: "demo",
  label: "Today’s Grok audit",
  status: "running",
  terminal: false,
  counts: { total: 3, queued: 0, running: 2, completed: 1, failed: 0, canceled: 0 },
  jobs: [
    { id: "inventory", label: "Inventory today’s work", status: "completed" },
    { id: "counterfactual", label: "Centipede counterfactual", status: "running" },
    { id: "adversarial", label: "Adversarial check", status: "running" },
  ],
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now(),
};

const completed: WorkerBatchProjection = {
  ...active,
  id: "completed",
  label: "Deployment verification",
  status: "completed",
  terminal: true,
  counts: { total: 3, queued: 0, running: 0, completed: 3, failed: 0, canceled: 0 },
  jobs: active.jobs.map((job) => ({ ...job, status: "completed" })),
};

const failed: WorkerBatchProjection = {
  ...active,
  id: "failed",
  label: "Guest-browser verification",
  status: "failed",
  terminal: true,
  counts: { total: 3, queued: 0, running: 0, completed: 2, failed: 1, canceled: 0 },
  jobs: [
    { id: "deploy", label: "Deploy selected artifact", status: "completed" },
    { id: "desktop", label: "Normal guest-browser check", status: "failed" },
    { id: "mobile", label: "Mobile smoke test", status: "completed" },
  ],
};

export function WorkerBatchPrototype() {
  return (
    <main className="min-h-screen bg-app px-5 py-12 text-ink">
      <div className="mx-auto max-w-[680px] space-y-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-secondary">Chat-native worker states</p>
        <WorkerBatchCard batch={active} />
        <WorkerBatchCard batch={completed} />
        <WorkerBatchCard batch={failed} />
      </div>
    </main>
  );
}
