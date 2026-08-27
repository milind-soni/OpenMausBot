// Choose which named remote worker a bot acts on.
//
// Workers are configured app-wide (Settings → Workers); a bot stores only the
// id. Readiness is probed by the control plane, so a row shows the first
// thing that is actually wrong rather than a generic "not ready".
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/page-visible";
import { workerPlatformLabel, workerStatusLine, type WorkerSummary } from "@/lib/workers";

const REFRESH_MS = 15_000;

export function WorkerPicker({
  selectedWorkerId,
  onSelect,
}: {
  selectedWorkerId?: string;
  onSelect: (workerId: string) => void;
}) {
  const [workers, setWorkers] = useState<WorkerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = usePageVisible();

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/workers", { headers: { "content-type": "application/json" } });
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        setWorkers(Array.isArray(body.workers) ? body.workers : []);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    // Each poll re-probes every worker over SSH, so keep it slow and stop it
    // entirely while the window is hidden.
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [visible]);

  if (error) {
    return <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[12px] text-ink-secondary">{error}</div>;
  }
  if (workers === null) {
    return <div className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[12px] text-ink-secondary">Checking workers…</div>;
  }
  if (workers.length === 0) {
    return (
      <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
        <div className="text-[13px] text-ink">No workers configured</div>
        <div className="mt-0.5 text-[11.5px] text-ink-secondary">
          Add a Windows PC or a macOS guest in Settings → Workers, then choose it here.
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-1.5">
      {workers.map((worker) => {
        const selected = worker.id === selectedWorkerId;
        return (
          <button
            key={worker.id}
            onClick={() => { if (!selected) onSelect(worker.id); }}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
              selected ? "bg-control" : "bg-inset hover:bg-control/60",
            )}
          >
            <div className="min-w-0">
              <div className="truncate text-[13px] text-ink">{worker.displayName}</div>
              <div className="mt-0.5 truncate text-[11.5px] text-ink-secondary">
                {workerPlatformLabel(worker.platform)} · {workerStatusLine(worker)}
              </div>
            </div>
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                worker.status.ready ? "bg-accent" : worker.status.lease ? "bg-ink-secondary" : "bg-hairline",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
