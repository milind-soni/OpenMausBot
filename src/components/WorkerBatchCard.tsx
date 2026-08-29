import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Circle, Loader2, OctagonX, Square, X } from "lucide-react";

import type { WorkerBatchJobStatus, WorkerBatchProjection } from "../../shared/worker-batch";
import { workerBatchSummary } from "@/lib/worker-batches";
import { cn } from "@/lib/cn";

const statusLabel = {
  queued: "Queued",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  canceled: "Canceled",
} satisfies Record<WorkerBatchJobStatus, string>;

function StatusIcon({ status }: { status: WorkerBatchJobStatus }) {
  if (status === "running") return <Loader2 aria-hidden size={14} className="animate-spin motion-reduce:animate-none" />;
  if (status === "completed") return <Check aria-hidden size={14} />;
  if (status === "failed") return <OctagonX aria-hidden size={14} />;
  if (status === "canceled") return <X aria-hidden size={14} />;
  return <Circle aria-hidden size={12} />;
}

export function WorkerBatchCard({ batch }: { batch: WorkerBatchProjection }) {
  const [expanded, setExpanded] = useState(!batch.terminal);
  const wasTerminal = useRef(batch.terminal);
  useEffect(() => {
    if (!wasTerminal.current && batch.terminal) setExpanded(false);
    wasTerminal.current = batch.terminal;
  }, [batch.terminal]);

  const summary = workerBatchSummary(batch);
  const attention = batch.status === "failed" || batch.status === "canceled";
  return (
    <section
      className={cn(
        "my-2 w-full max-w-[620px] overflow-hidden rounded-[18px] border bg-panel/80 shadow-sm",
        attention ? "border-danger/25" : "border-hairline/45",
      )}
      aria-label={`${batch.label}: ${summary}`}
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-control/35"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-xl border",
            batch.terminal
              ? attention
                ? "border-danger/25 bg-danger/10 text-danger"
                : "border-success/25 bg-success/10 text-success"
              : "border-accent/25 bg-accent/10 text-accent",
          )}
        >
          {batch.status === "running" ? (
            <Loader2 aria-hidden size={15} className="animate-spin motion-reduce:animate-none" />
          ) : batch.status === "completed" ? (
            <Check aria-hidden size={15} />
          ) : batch.status === "failed" ? (
            <OctagonX aria-hidden size={15} />
          ) : batch.status === "canceled" ? (
            <Square aria-hidden size={13} />
          ) : (
            <Circle aria-hidden size={12} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{batch.label}</span>
          <span className={cn("block text-[12px] text-ink-secondary", attention && "text-danger")} aria-live="polite">
            {summary}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          size={16}
          className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", expanded && "rotate-180")}
        />
      </button>

      {expanded && (
        <div className="border-t border-hairline/35 px-3 py-2.5">
          <ul className="space-y-1" aria-label="Worker lanes">
            {batch.jobs.map((job) => (
              <li
                key={job.id}
                className="flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[12.5px] text-ink-secondary"
              >
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center",
                    job.status === "running" && "text-accent",
                    job.status === "completed" && "text-success",
                    job.status === "failed" && "text-danger",
                  )}
                >
                  <StatusIcon status={job.status} />
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">{job.label}</span>
                <span className="shrink-0 text-right text-[11.5px]">
                  {job.status === "queued" && job.waitingReason ? job.waitingReason : statusLabel[job.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
