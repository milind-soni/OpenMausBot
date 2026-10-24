import { useEffect, useRef, useState } from "react";
import { api } from "@/state/api";
import type { JobCancellationResult, JobCancellationSnapshot } from "../../shared/job-cancellation";

interface NativeJobView {
  version?: string;
  roots: string[];
  nodes: Array<{ id: string; rootId?: string; parentId?: string; botId: string; threadId: string; status: string; sourceRequest?: string }>;
  current?: { rootId: string; status: string; outcome?: string; state: string; reason: string; sourceRequest?: string; legacyTaskOutcome?: true } | null;
  unconfirmedStops?: Array<{ rootId: string; sourceRequest?: string }>;
}

export function chiefJobRoots(job: NativeJobView, botId: string, threadId: string): string[] {
  const roots = new Set(job.roots);
  return job.nodes.filter(node => roots.has(node.id) && !node.parentId && node.botId === botId && node.threadId === threadId &&
    job.nodes.some(member => (member.id === node.id || member.rootId === node.id) &&
      !["completed", "failed", "cancelled"].includes(member.status))).map(node => node.id);
}

export function ChiefJobCancelActions({ chief, canWrite, roots, pending, onCancel, sourceRequests = {} }: {
  chief: boolean; canWrite: boolean; roots: string[]; pending: string | null; onCancel(rootId: string): void;
  sourceRequests?: Record<string, string>;
}) {
  if (!chief || !canWrite || roots.length === 0) return null;
  return <div className="flex flex-wrap justify-end gap-2">
    {roots.map(rootId => <button key={rootId} type="button" disabled={pending !== null}
      onClick={() => onCancel(rootId)} title={`${sourceRequests[rootId] ? `${sourceRequests[rootId]}\n` : ""}Cancel job ${rootId}, including running hand-offs`}
      className="pointer-events-auto max-w-full rounded-full border border-danger/30 bg-raised px-3 py-1 text-left text-[12px] font-medium text-danger disabled:opacity-50">
      <span className="block max-w-[min(28rem,70vw)] truncate">{pending === rootId ? "Cancelling job…" : sourceRequests[rootId]
        ? `Cancel: ${sourceRequests[rootId]}` : roots.length === 1 ? "Cancel job" : `Cancel job ${rootId.slice(0, 8)}`}</span>
    </button>)}
  </div>;
}

function currentJobMessage(current: NonNullable<NativeJobView["current"]>): string {
  if (current.status === "cancelled") return "Job cancelled. Partial reports are retained.";
  if (current.state === "blocked") return `Job blocked: ${current.reason}`;
  if (current.state === "needs-input") return "Job needs your input.";
  if (current.outcome === "interrupted") return "Job interrupted. Work will not be repeated.";
  if (current.state === "failed") return "Job failed.";
  if (current.state === "stalled") return "Job stalled.";
  if (current.status === "queued" || current.status === "resume") return "Job queued.";
  if (current.status === "waiting") return current.state === "running" ? "Waiting on teammates." : "Waiting to continue.";
  if (current.state === "completed") return current.legacyTaskOutcome
    ? "Engine turn finished. Task outcome unrecorded and unverified." : "Job completed.";
  return "Job running.";
}

export function ChiefJobCancel({ botId, threadId, activeLeafId, busy, waiting, connected = true, receipts = [], chief = false, canWrite = false }: {
  botId: string; threadId: string; activeLeafId?: string | null; busy: boolean; waiting: boolean;
  connected?: boolean; chief?: boolean; canWrite?: boolean;
  receipts?: JobCancellationResult[];
}) {
  const receiptKey = JSON.stringify(receipts.map(receipt => [receipt.rootId, receipt.state, receipt.activeIds, receipt.stoppedIds, receipt.errors]));
  const key = JSON.stringify([botId, threadId, activeLeafId, busy, waiting, connected, chief, canWrite, receiptKey]);
  const [snapshot, setSnapshot] = useState<{ key: string; job?: NativeJobView; failed?: boolean } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<{ rootId: string } | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [localReceipt, setLocalReceipt] = useState<{ key: string; receipt: JobCancellationResult } | null>(null);
  const revision = useRef(0);
  const cancellation = useRef<typeof pending>(null);
  useEffect(() => {
    const current = ++revision.current;
    const abort = new AbortController();
    setSnapshot(previous => previous?.key === key ? previous : null);
    if (connected) void (async () => {
      let version = "";
      try {
        do {
          const query = version ? `&version=${encodeURIComponent(version)}&wait=25000` : "";
          const job = await api<NativeJobView>(`/api/threads/${encodeURIComponent(threadId)}/job?since=0${query}`,
            { signal: abort.signal, background: true });
          if (revision.current !== current || abort.signal.aborted) return;
          setSnapshot(previous => previous?.key === key && previous.job?.version && previous.job.version === job.version ? previous : { key, job });
          version = job.version ?? "";
          if (!version || (chiefJobRoots(job, botId, threadId).length === 0 && !["running", "needs-input"].includes(job.current?.state ?? ""))) break;
        } while (!abort.signal.aborted);
      } catch {
        if (revision.current === current && !abort.signal.aborted) setSnapshot({ key, failed: true });
      }
    })();
    return () => { abort.abort(); revision.current++; };
  }, [botId, threadId, key, connected, refresh]);

  useEffect(() => {
    const revalidate = () => setRefresh(value => value + 1);
    window.addEventListener("focus", revalidate); window.addEventListener("online", revalidate);
    return () => { window.removeEventListener("focus", revalidate); window.removeEventListener("online", revalidate); };
  }, []);

  const cancel = async (rootId: string) => {
    if (!chief || !canWrite || cancellation.current) return;
    const current = revision.current;
    const operation = { rootId };
    cancellation.current = operation; setPending(operation); setError(null);
    const base = `/api/bots/${encodeURIComponent(botId)}/jobs/${encodeURIComponent(rootId)}`;
    try {
      const snapshot = await api<JobCancellationSnapshot>(`${base}/cancellation`);
      if (revision.current !== current) return;
      const result = await api<JobCancellationResult>(`${base}/cancel`, { method: "POST", body: JSON.stringify(snapshot) });
      if (revision.current !== current) return;
      setLocalReceipt({ key, receipt: result });
    } catch (error) {
      if (revision.current === current) setError({ key, text: error instanceof Error ? error.message : "Cancellation was not confirmed." });
    } finally {
      if (cancellation.current === operation) { cancellation.current = null; setPending(null); }
      if (revision.current === current) setRefresh(value => value + 1);
    }
  };
  const shown = snapshot?.key === key ? snapshot : null;
  const job = shown?.job;
  const roots = job ? chiefJobRoots(job, botId, threadId) : [];
  const sourceRequests = Object.fromEntries(job?.nodes.flatMap(node => !node.parentId && node.sourceRequest ? [[node.id, node.sourceRequest] as const] : []) ?? []);
  const byRoot = new Map(receipts.map(receipt => [receipt.rootId, receipt]));
  if (localReceipt?.key === key) byRoot.set(localReceipt.receipt.rootId, localReceipt.receipt);
  const warnings = new Map(job?.unconfirmedStops?.map(stop => [stop.rootId, { request: stop.sourceRequest, unconfirmed: true }]));
  for (const receipt of byRoot.values()) if (receipt.state === "partial" && !warnings.has(receipt.rootId)) {
    warnings.set(receipt.rootId, { request: sourceRequests[receipt.rootId], unconfirmed: false });
  }
  for (const rootId of roots) if (job?.nodes.some(node => node.id === rootId && node.status === "cancelled")) {
    warnings.set(rootId, { request: sourceRequests[rootId] ?? warnings.get(rootId)?.request, unconfirmed: true });
  }
  const status = !connected || shown?.failed ? "Job status unavailable." : job?.current ? currentJobMessage(job.current)
    : job ? "No current job." : "Checking job status…";
  return <div className="pointer-events-auto px-5 pb-2">
    <ChiefJobCancelActions chief={chief} canWrite={canWrite} roots={roots} sourceRequests={sourceRequests} pending={pending?.rootId ?? null} onCancel={rootId => { void cancel(rootId); }} />
    <p role="status" data-current-job-id={job?.current?.rootId} title={job?.current?.reason}
      className="mt-1 text-right text-[12px] text-ink-secondary">{status}</p>
    {job?.current?.legacyTaskOutcome && <p data-legacy-task-outcome className="mt-1 text-right text-[12px] text-ink-secondary">The engine turn finished; the requested-task disposition was not recorded.</p>}
    {[...warnings].map(([rootId, warning]) => <p key={rootId} role="status" data-unconfirmed-job-id={rootId} title={rootId}
      className="mt-1 text-right text-[12px] text-ink-secondary">{rootId === job?.current?.rootId ? "" : `Earlier job${warning.request ? ` — ${warning.request}` : ""}: `}
      {warning.unconfirmed ? "Cancellation is partial. Local work has not confirmed it stopped; partial reports are retained."
        : "Cancellation reported partial. Review the retained reports."}</p>)}
    {error?.key === key && <p role="alert" className="mt-1 text-right text-[12px] text-ink-secondary">{error.text}</p>}
  </div>;
}
