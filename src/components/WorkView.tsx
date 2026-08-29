import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, CircleAlert, Clock3, FileCheck2, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  EMPTY_WORK_PROJECTION,
  parseWorkProjection,
  workSections,
  workStatusLabel,
  type WorkDeadline,
  type WorkObligation,
  type WorkProjection,
} from "@/lib/work";

export async function loadWork(signal?: AbortSignal): Promise<WorkProjection> {
  const response = await fetch("/api/work?limit=200", { signal });
  if (!response.ok) throw new Error(`Work could not be loaded (${response.status})`);
  const body = await response.json();
  return parseWorkProjection(body);
}

function dateLabel(timestamp: number): string {
  if (!timestamp) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function statusClass(status: WorkObligation["status"]): string {
  switch (status) {
    case "blocked": return "bg-danger/15 text-danger";
    case "in_progress": return "bg-accent/15 text-accent-text";
    case "completed": return "bg-success/15 text-success";
    case "cancelled": return "bg-control text-ink-secondary";
    case "open": return "bg-warning/15 text-warning";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

function nearestDeadline(obligation: WorkObligation, projection: WorkProjection): WorkDeadline | undefined {
  return [...obligation.deadlines, ...projection.deadlines.filter((deadline) => deadline.obligationId === obligation.id)]
    .filter((deadline, index, deadlines) => deadlines.findIndex((candidate) => candidate.id === deadline.id) === index)
    .sort((a, b) => a.dueAt - b.dueAt)[0];
}

function completionLabel(obligation: WorkObligation): string {
  if (obligation.status === "completed") return "Completed with evidence";
  if (obligation.status === "cancelled") return "Cancelled";
  const pending = obligation.approvals.some((approval) => approval.status === "pending");
  if (pending) return "Waiting on approval";
  if (obligation.evidence.length > 0) return "Evidence recorded · ready to close";
  return "Evidence required before completion";
}

function WorkCard({ obligation, projection }: { obligation: WorkObligation; projection: WorkProjection }) {
  const deadline = nearestDeadline(obligation, projection);
  const overdue = deadline?.status === "missed" || (deadline?.status === "active" && deadline.dueAt < Date.now());
  return (
    <article className="rounded-2xl border border-hairline/45 bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl", obligation.status === "blocked" ? "bg-danger/12 text-danger" : "bg-accent/10 text-accent-text")}>
          {obligation.status === "blocked" ? <CircleAlert size={16} /> : <FileCheck2 size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{obligation.title}</h3>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", statusClass(obligation.status))}>{workStatusLabel(obligation.status)}</span>
          </div>
          {obligation.description && <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{obligation.description}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-secondary">
            {obligation.owner && <span>Owner · {obligation.owner.label || obligation.owner.id}</span>}
            <span>Updated · {dateLabel(obligation.updatedAt)}</span>
            {deadline && <span className={cn(overdue && "font-semibold text-danger")}>Due · {dateLabel(deadline.dueAt)}</span>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-hairline/30 pt-3 text-[11px]">
        {obligation.evidence.length > 0 ? <CheckCircle2 size={14} className="text-success" /> : <ShieldAlert size={14} className="text-warning" />}
        <span className="text-ink-secondary">{obligation.evidence.length} evidence {obligation.evidence.length === 1 ? "item" : "items"}</span>
        <span className="text-hairline">·</span>
        <span className={cn(obligation.approvals.some((approval) => approval.status === "pending") ? "text-warning" : "text-ink-secondary")}>{completionLabel(obligation)}</span>
      </div>
      {obligation.evidence.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-xl border border-success/20 bg-success/5 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-success">Evidence</div>
          {obligation.evidence.map((item) => (
            <div key={item.id} className="text-[11.5px] leading-relaxed text-ink">
              <span className="font-medium capitalize">{item.kind}:</span> {item.summary}
              {item.reference && <div className="truncate font-mono text-[10px] text-ink-secondary">{item.reference}</div>}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function ApprovalCard({ approval, title }: { approval: WorkProjection["pendingApprovals"][number]; title: string }) {
  return (
    <article className="rounded-2xl border border-warning/30 bg-warning/8 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-warning/15 text-warning"><ShieldAlert size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-warning">Needs your decision</div>
          <h3 className="mt-1 text-[14px] font-semibold text-ink">{approval.prompt}</h3>
          <p className="mt-1 text-[11.5px] text-ink-secondary">For {title}{approval.requestedBy ? ` · requested by ${approval.requestedBy}` : ""}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-warning/20 pt-3 text-[10.5px] text-ink-secondary">
        <ShieldAlert size={13} className="text-warning" />
        <span>Payload details stay redacted here. Review the linked task before deciding.</span>
      </div>
    </article>
  );
}

function Section({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-[11px] text-ink-secondary">{detail}</p>
        </div>
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function WorkView() {
  const [projection, setProjection] = useState<WorkProjection>(EMPTY_WORK_PROJECTION);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRefreshing(true);
    setError(null);
    void loadWork(controller.signal)
      .then(setProjection)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Work could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => controller.abort();
  }, [refreshNonce]);

  const sections = useMemo(() => workSections(projection), [projection]);
  const titleByObligation = useMemo(() => new Map(projection.obligations.map((obligation) => [obligation.id, obligation.title])), [projection.obligations]);
  const visibleWork = [...sections.openLocks, ...sections.activeWork, ...sections.completed];
  const hasWork = visibleWork.length > 0;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app text-ink">
      <div className="mx-auto w-full max-w-[860px] px-5 py-8 md:px-8 md:py-10">
        <header className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Durable work</div>
            <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.03em] text-ink">Work</h1>
            <p className="mt-1 max-w-[620px] text-[13px] leading-relaxed text-ink-secondary">Open locks, decisions, active work, and the evidence behind completion.</p>
          </div>
          <button type="button" onClick={refresh} disabled={refreshing} aria-label="Refresh work" title="Refresh work" className="grid size-9 shrink-0 place-items-center rounded-xl border border-hairline/45 bg-card text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50">
            <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
          </button>
        </header>

        {error && <div role="alert" className="mt-6 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</div>}
        {loading && !hasWork ? <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={16} className="animate-spin" />Loading work…</div> : !hasWork && !error ? <div className="mt-8 rounded-2xl border border-dashed border-hairline/50 bg-card/50 px-6 py-12 text-center"><Check size={20} className="mx-auto text-success" /><h2 className="mt-3 text-[15px] font-semibold text-ink">Nothing is waiting</h2><p className="mx-auto mt-1 max-w-[360px] text-[12px] leading-relaxed text-ink-secondary">New durable work, approvals, and evidence will appear here when they exist.</p></div> : (
          <div className="mt-8 space-y-8">
            {sections.approvals.length > 0 && <Section title="Needs you" detail="Approvals pause work until you make the decision.">{sections.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} title={titleByObligation.get(approval.obligationId) ?? "this work"} />)}</Section>}
            {sections.openLocks.length > 0 && <Section title="Open locks" detail="Durable obligations that are open or blocked.">{sections.openLocks.map((obligation) => <WorkCard key={obligation.id} obligation={obligation} projection={projection} />)}</Section>}
            {sections.activeWork.length > 0 && <Section title="Active work" detail="Obligations currently being worked.">{sections.activeWork.map((obligation) => <WorkCard key={obligation.id} obligation={obligation} projection={projection} />)}</Section>}
            {sections.completed.length > 0 && <Section title="Completed" detail="Recent completions retained with their proof.">{sections.completed.map((obligation) => <WorkCard key={obligation.id} obligation={obligation} projection={projection} />)}</Section>}
          </div>
        )}

        <footer className="mt-8 flex items-center gap-2 text-[10.5px] text-ink-secondary"><Clock3 size={13} />{projection.generatedAt ? `Last checked ${dateLabel(projection.generatedAt)}` : "Waiting for the work projection"}</footer>
      </div>
    </main>
  );
}
