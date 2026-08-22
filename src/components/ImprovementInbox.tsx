import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  GitBranch,
  Hash,
  FileCheck2,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { api, useStore, type ImprovementFeed } from "@/state/store";
import type {
  AgentGraph,
  AgentGraphNodeStatus,
  AgentGraphRunReceipt,
  AgentGraphVerificationPathInput,
} from "../../shared/agent-graphs";

interface ReceiptSnapshot {
  receipt: AgentGraphRunReceipt;
  receiptHash: string;
}

export function verificationPathInputs(
  graph: AgentGraph,
  paths: Record<string, string>,
): AgentGraphVerificationPathInput[] {
  return graph.nodes.flatMap((node) => {
    const relativePath = paths[node.id]?.trim();
    return relativePath ? [{ nodeId: node.id, relativePath }] : [];
  });
}

function compactHash(value: string | null | undefined): string {
  if (!value) return "not supplied";
  return value.length > 28 ? `${value.slice(0, 15)}…${value.slice(-9)}` : value;
}

function when(value: string | number | null | undefined): string {
  if (value == null) return "unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "unknown";
}

function statusTone(status: AgentGraph["status"] | AgentGraphNodeStatus): string {
  if (status === "completed") return "text-success";
  if (status === "blocked" || status === "failed") return "text-danger";
  if (status === "running" || status === "approved") return "text-accent";
  if (status === "waiting_for_approval") return "text-warning";
  return "text-ink-secondary";
}

function FeedHealth({ feed }: { feed: ImprovementFeed | null }) {
  const healthy = feed?.state === "fresh";
  return (
    <section className="rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn("flex size-9 items-center justify-center rounded-xl", healthy ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>
            {healthy ? <ShieldCheck size={19} /> : <AlertTriangle size={19} />}
          </span>
          <div>
            <div className="text-[14px] font-medium text-ink">Governed proposal feed</div>
            <div className="text-[12px] text-ink-secondary">
              {feed ? `${feed.state} · generated ${when(feed.generated_at)}` : "Loading feed health…"}
            </div>
          </div>
        </div>
        <div className="rounded-full border border-hairline/50 bg-raised/50 px-3 py-1 text-[11px] text-ink-secondary">
          instruction authority: false
        </div>
      </div>
      <div className="mt-3 grid gap-2 text-[11.5px] text-ink-secondary sm:grid-cols-3">
        <div>Feed hash: <span className="font-mono text-ink">{compactHash(feed?.feed_hash)}</span></div>
        <div>Mutation authority: <span className="text-ink">none</span></div>
        <div>Visible proposals: <span className="text-ink">{feed?.proposals.length ?? 0}</span></div>
      </div>
    </section>
  );
}

function GraphDetail({
  graph,
  busy,
  onApprove,
  onCancel,
  onVerify,
  onEvidencePath,
  approveAvailable,
  cancelAvailable,
  verifyAvailable,
  receiptSnapshot,
  evidencePaths,
}: {
  graph: AgentGraph;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onVerify: () => void;
  onEvidencePath: (nodeId: string, path: string) => void;
  approveAvailable: boolean;
  cancelAvailable: boolean;
  verifyAvailable: boolean;
  receiptSnapshot: ReceiptSnapshot | null;
  evidencePaths: Record<string, string>;
}) {
  return (
    <section className="rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <GitBranch size={17} className="text-accent" /> Graph preview
          </div>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-ink-secondary">{graph.objective}</p>
        </div>
        <span className={cn("rounded-full bg-raised px-2.5 py-1 text-[11px] font-medium", statusTone(graph.status))}>{graph.status}</span>
      </div>
      <div className="mt-3 rounded-xl border border-accent/20 bg-accent/5 p-3">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-ink-secondary"><Hash size={13} /> Exact approval hash</div>
        <div className="mt-1 break-all font-mono text-[11.5px] text-ink">{graph.graphHash}</div>
      </div>
      <div className="mt-3 grid gap-2 rounded-xl border border-hairline/40 bg-app/50 p-3 text-[11.5px] text-ink-secondary sm:grid-cols-2 lg:grid-cols-4">
        <div>Goal: <span className="font-mono text-ink">{graph.goalId ?? "none"}</span></div>
        <div>Parallel nodes: <span className="text-ink">{graph.maxParallel}</span></div>
        <div>Proposal IDs: <span className="font-mono text-ink">{graph.proposalIds.join(", ") || "none"}</span></div>
        <div>Feed: <span className="font-mono text-ink">{compactHash(graph.feedHash)}</span></div>
      </div>
      {graph.proposalSnapshots.length > 0 && (
        <div className="mt-3 space-y-2 rounded-xl border border-warning/20 bg-warning/5 p-3">
          <div className="text-[10.5px] uppercase tracking-wide text-warning">Hash-bound untrusted proposal data</div>
          {graph.proposalSnapshots.map((proposal) => (
            <div key={proposal.proposalId} className="text-[11.5px] text-ink-secondary">
              <span className="font-medium text-ink">{proposal.title}</span> · recurrence {proposal.recurrence} · content <span className="font-mono">{compactHash(proposal.contentHash)}</span>
              {proposal.proposedChange && <div className="mt-1 whitespace-pre-wrap text-ink">{proposal.proposedChange}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 space-y-3">
        {graph.nodes.map((node) => (
          <article key={node.id} className="rounded-xl border border-hairline/40 bg-app/50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-[13px] font-medium text-ink">{node.id}. {node.title}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                  {node.role} · {node.permissionClass} · depends on {node.dependsOn.length ? node.dependsOn.join(", ") : "nothing"}
                </div>
              </div>
              <span className={cn("text-[11px] font-medium", statusTone(node.status))}>{node.status.replaceAll("_", " ")}</span>
            </div>
            <div className="mt-2 text-[11.5px] text-ink-secondary">
              Approved routes: {node.routes.map((route) => `${route.botId} / ${route.instanceId} / ${route.engine} / ${route.model} / ${route.workspaceRoot}`).join(" → ")}
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div>
                <div className="text-[10.5px] uppercase tracking-wide text-ink-secondary">Success</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-[11.5px] text-ink">{node.successCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
              </div>
              <div>
                <div className="text-[10.5px] uppercase tracking-wide text-ink-secondary">Proof</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-[11.5px] text-ink">{node.proofRequirements.map((proof) => <li key={proof}>{proof}</li>)}</ul>
              </div>
            </div>
            {node.error && <div className="mt-2 rounded-lg bg-danger/10 px-2.5 py-2 text-[11.5px] text-danger">{node.error}</div>}
          </article>
        ))}
      </div>
      {graph.status === "completed" && (
        <section className="mt-4 rounded-xl border border-success/20 bg-success/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                <FileCheck2 size={15} className="text-success" /> Host evidence verification
              </div>
              <p className="mt-1 text-[11.5px] text-ink-secondary">
                Thread receipts are provenance only. Every completed node needs a workspace-relative file that the host can read and hash.
              </p>
            </div>
            <span className={cn(
              "rounded-full bg-raised px-2.5 py-1 text-[11px] font-medium",
              receiptSnapshot?.receipt.verification_status === "verified" ? "text-success" : "text-warning",
            )}>
              {receiptSnapshot?.receipt.verification_status ?? "loading receipt"}
            </span>
          </div>
          {receiptSnapshot && (
            <div className="mt-2 break-all font-mono text-[10.5px] text-ink-secondary">
              receipt {receiptSnapshot.receiptHash}
              {receiptSnapshot.receipt.evidence_manifest_hash && <> · evidence {receiptSnapshot.receipt.evidence_manifest_hash}</>}
            </div>
          )}
          {receiptSnapshot?.receipt.verification_status === "unverified" && (
            <div className="mt-3 space-y-2">
              {graph.nodes.map((node) => (
                <label key={node.id} className="grid gap-1 text-[11px] text-ink-secondary md:grid-cols-[160px_1fr] md:items-center">
                  <span className="font-medium text-ink">{node.id} evidence</span>
                  <input
                    value={evidencePaths[node.id] ?? ""}
                    onChange={(event) => onEvidencePath(node.id, event.target.value)}
                    maxLength={700}
                    placeholder="relative/path/to/evidence"
                    className="h-9 rounded-lg border border-hairline/50 bg-app px-2.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent/50"
                  />
                </label>
              ))}
              <button
                type="button"
                disabled={busy || !verifyAvailable}
                onClick={onVerify}
                className="inline-flex items-center gap-2 rounded-xl bg-success px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Preview hashes and verify exact run
              </button>
            </div>
          )}
          {receiptSnapshot?.receipt.verification_status === "verified" && (
            <div className="mt-3 space-y-2 text-[11.5px] text-ink-secondary">
              <div>Verified {when(receiptSnapshot.receipt.verified_at)}</div>
              {receiptSnapshot.receipt.nodes.flatMap((node) => node.verified_evidence).map((item) => (
                <div key={`${item.node_id}:${item.relative_path}`} className="rounded-lg border border-hairline/40 bg-app/60 px-2.5 py-2">
                  <span className="font-medium text-ink">{item.node_id}</span> · <span className="font-mono">{item.relative_path}</span>
                  <div className="mt-0.5 break-all font-mono text-[10.5px]">{item.sha256} · {item.bytes} bytes</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {graph.status === "draft" && (
          <button type="button" disabled={busy || !approveAvailable} onClick={onApprove} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} Approve exact graph
          </button>
        )}
        {!["completed", "blocked", "cancelled"].includes(graph.status) && graph.status !== "draft" && (
          <button type="button" disabled={busy || !cancelAvailable} onClick={onCancel} className="inline-flex items-center gap-2 rounded-xl border border-danger/30 px-4 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50">
            <Ban size={15} /> Cancel graph tasks
          </button>
        )}
        <span className="text-[11.5px] text-ink-secondary">Approval covers this hash's safe local scope once. Protected actions still pause.</span>
      </div>
    </section>
  );
}

export function ImprovementInbox() {
  const { state, dispatch } = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [objective, setObjective] = useState("");
  const [goalId, setGoalId] = useState("");
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [receiptSnapshot, setReceiptSnapshot] = useState<ReceiptSnapshot | null>(null);
  const [evidencePaths, setEvidencePaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopMutations = Boolean(window.ogb?.agentGraphs);
  const cancellationAvailable = state.agentGraphsEnabled && desktopMutations && state.agentGraphDesktopMutationsAvailable;
  const mutationsAvailable = cancellationAvailable &&
    state.agentGraphStorageHealth.state === "healthy";
  const graph = useMemo(
    () => state.agentGraphs.find((candidate) => candidate.id === selectedGraphId) ?? state.agentGraphs[0] ?? null,
    [selectedGraphId, state.agentGraphs],
  );

  useEffect(() => {
    let active = true;
    setReceiptSnapshot(null);
    setEvidencePaths({});
    if (!graph || graph.status !== "completed") return () => { active = false; };
    void api(`/api/agent-graphs/${graph.id}/receipt`).then((snapshot: ReceiptSnapshot) => {
      if (active) setReceiptSnapshot(snapshot);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [graph?.id, graph?.status]);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    const graphBaselineRevisions = Object.fromEntries(
      state.agentGraphs.map((candidate) => [candidate.id, candidate.revision]),
    );
    try {
      const [feed, graphs] = await Promise.all([api("/api/improvements"), api("/api/agent-graphs")]);
      setSelected((current) => current.filter((proposalId) =>
        feed.proposals.some((proposal: { proposal_id: string }) => proposal.proposal_id === proposalId)));
      dispatch({ type: "improvementsHydrated", feed });
      dispatch({
        type: "agentGraphsHydrated",
        graphs: graphs.graphs ?? [],
        enabled: graphs.enabled === true,
        desktopMutationsAvailable: graphs.desktop_mutations_available === true,
        health: graphs.health ?? { state: "degraded", quarantined: [], sinkErrors: ["graph storage health unavailable"] },
        baselineRevisions: graphBaselineRevisions,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!state.agentGraphsEnabled) throw new Error("Agent graphs are disabled for this rollout");
      if (!window.ogb?.agentGraphs) throw new Error("Graph preview requires the trusted OpenMausBot desktop window");
      const result = await window.ogb.agentGraphs.preview({ objective, proposalIds: selected, goalId: goalId.trim() || null });
      dispatch({ type: "agentGraphPatched", graph: result.graph });
      setSelectedGraphId(result.graph.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mutateGraph = async (action: "approve" | "cancel" | "verify") => {
    if (!graph) return;
    setBusy(true);
    setError(null);
    try {
      if (!state.agentGraphsEnabled) throw new Error("Agent graphs are disabled for this rollout");
      if (!window.ogb?.agentGraphs) throw new Error("Graph controls require the trusted OpenMausBot desktop window");
      if (action === "verify") {
        if (!receiptSnapshot || receiptSnapshot.receipt.verification_status !== "unverified") {
          throw new Error("Read the current unverified graph receipt before verification");
        }
        const paths = verificationPathInputs(graph, evidencePaths);
        if (paths.length !== graph.nodes.length) throw new Error("Every completed graph node requires one relative evidence path");
        const result = await window.ogb.agentGraphs.verify(graph.id, graph.graphHash, receiptSnapshot.receiptHash, paths);
        const readback = await api(`/api/agent-graphs/${graph.id}/receipt`) as ReceiptSnapshot;
        if (readback.receiptHash !== result.receiptHash || readback.receipt.verification_status !== "verified") {
          throw new Error("Verified graph receipt readback did not match the desktop result");
        }
        setReceiptSnapshot(readback);
      } else {
        const result = action === "approve"
          ? await window.ogb.agentGraphs.approve(graph.id, graph.graphHash)
          : await window.ogb.agentGraphs.cancel(graph.id);
        dispatch({ type: "agentGraphPatched", graph: result.graph });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const verifyAvailable = Boolean(
    graph && receiptSnapshot?.receipt.verification_status === "unverified" && mutationsAvailable &&
    verificationPathInputs(graph, evidencePaths).length === graph.nodes.length,
  );
  const feed = state.improvements;
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-app">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-6 sm:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[19px] font-semibold text-ink"><Sparkles size={21} className="text-accent" /> Improvement Inbox</div>
            <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-ink-secondary">
              Display-only observer proposals. Previewing creates a draft DAG; nothing runs until the exact graph hash is approved.
            </p>
          </div>
          <button type="button" disabled={busy} onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[12.5px] text-ink hover:bg-raised disabled:opacity-50">
            <RefreshCw size={15} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </header>

        <FeedHealth feed={feed} />

        {!state.agentGraphsEnabled && (
          <div className="rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-[12px] text-warning">
            Inbox is read-only. Agent graph preview and execution are disabled until <span className="font-mono">OMB_AGENT_GRAPHS_ENABLED=1</span> is set for a controlled rollout.
          </div>
        )}
        {state.agentGraphsEnabled && !desktopMutations && (
          <div className="rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-[12px] text-warning">
            Inbox reads and graph history are available here, but preview, approval, and cancellation require the trusted OpenMausBot desktop window.
          </div>
        )}
        {state.agentGraphsEnabled && desktopMutations && !state.agentGraphDesktopMutationsAvailable && (
          <div className="rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-[12px] text-warning">
            Graph history is readable, but this server boot did not receive the private desktop approval authority. Restart the desktop app before previewing or approving a graph.
          </div>
        )}
        {state.agentGraphStorageHealth.state !== "healthy" && (
          <div className="rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 text-[12px] text-danger">
            Agent graph storage is {state.agentGraphStorageHealth.state}. Preview and approval stay unavailable until the bounded store is healthy; cancellation remains available for an already-running graph.
            {state.agentGraphStorageHealth.quarantined.length > 0 && ` ${state.agentGraphStorageHealth.quarantined.length} record(s) were quarantined.`}
            {state.agentGraphStorageHealth.sinkErrors.length > 0 && ` ${state.agentGraphStorageHealth.sinkErrors[0]}`}
          </div>
        )}
        {error && <div role="alert" className="rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 text-[12px] text-danger">{error}</div>}

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[14px] font-medium text-ink">Proposals</h2>
            <span className="text-[11.5px] text-ink-secondary">Choose zero or more</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {(feed?.proposals ?? []).map((proposal) => {
              const checked = selected.includes(proposal.proposal_id);
              return (
                <label key={proposal.proposal_id} className={cn("cursor-pointer rounded-2xl border bg-card p-4 transition-colors", checked ? "border-accent/50" : "border-hairline/50 hover:border-hairline")}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={checked} onChange={() => setSelected((current) => checked ? current.filter((id) => id !== proposal.proposal_id) : [...current, proposal.proposal_id])} className="mt-1 accent-[var(--color-accent)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium text-ink">{proposal.title}</div>
                      <div className="mt-1 text-[11px] text-ink-secondary">{proposal.category ?? "uncategorized"} · recurrence {proposal.recurrence_count} · expires {when(proposal.expires_at)}</div>
                      {proposal.display_only.proposed_change && <p className="mt-3 whitespace-pre-wrap text-[12px] leading-relaxed text-ink">{proposal.display_only.proposed_change}</p>}
                      <div className="mt-3 grid gap-2 text-[11.5px] md:grid-cols-2">
                        <div><span className="text-ink-secondary">Risk:</span> {proposal.display_only.risk ?? "not supplied"}</div>
                        <div><span className="text-ink-secondary">Rollback:</span> {proposal.display_only.rollback ?? "not supplied"}</div>
                      </div>
                      {proposal.display_only.tests.length > 0 && <div className="mt-2 text-[11.5px]"><span className="text-ink-secondary">Tests:</span> {proposal.display_only.tests.join(" · ")}</div>}
                      <div className="mt-3 break-all font-mono text-[10.5px] text-ink-secondary">content {compactHash(proposal.content_hash)} · evidence {proposal.evidence_hashes.map(compactHash).join(", ")}</div>
                    </div>
                  </div>
                </label>
              );
            })}
            {feed?.state === "fresh" && feed.proposals.length === 0 && <div className="rounded-2xl border border-dashed border-hairline/50 p-8 text-center text-[12.5px] text-ink-secondary">No safe fresh proposals are available.</div>}
          </div>
        </section>

        <section className="rounded-2xl border border-hairline/50 bg-card p-4">
          <div className="flex items-center gap-2 text-[14px] font-medium text-ink"><Clock3 size={17} className="text-accent" /> Preview an agent graph</div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px_auto]">
            <textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={4000} rows={3} placeholder="Bounded objective for the graph" className="resize-none rounded-xl border border-hairline/50 bg-app px-3 py-2.5 text-[12.5px] text-ink outline-none focus:border-accent/50" />
            <input value={goalId} onChange={(event) => setGoalId(event.target.value)} maxLength={160} placeholder="Optional goal ID" className="h-10 rounded-xl border border-hairline/50 bg-app px-3 text-[12.5px] text-ink outline-none focus:border-accent/50" />
            <button type="button" disabled={busy || !mutationsAvailable || !objective.trim()} onClick={() => void preview()} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[12.5px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <GitBranch size={15} />} Preview graph
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-secondary">A goal identifies the objective; it does not authorize unattended execution. Role suggestions select routes but grant no tools.</p>
        </section>

        {graph && <GraphDetail
          graph={graph}
          busy={busy}
          approveAvailable={mutationsAvailable}
          cancelAvailable={cancellationAvailable}
          verifyAvailable={verifyAvailable}
          receiptSnapshot={receiptSnapshot}
          evidencePaths={evidencePaths}
          onEvidencePath={(nodeId, path) => setEvidencePaths((current) => ({ ...current, [nodeId]: path }))}
          onApprove={() => void mutateGraph("approve")}
          onCancel={() => void mutateGraph("cancel")}
          onVerify={() => void mutateGraph("verify")}
        />}

        {state.agentGraphs.length > 1 && (
          <section className="rounded-2xl border border-hairline/50 bg-card p-4">
            <h2 className="text-[14px] font-medium text-ink">Graph history</h2>
            <div className="mt-2 space-y-1">
              {state.agentGraphs.map((candidate) => (
                <button key={candidate.id} type="button" onClick={() => setSelectedGraphId(candidate.id)} className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-raised/50">
                  <span className="truncate text-[12px] text-ink">{candidate.objective}</span>
                  <span className={cn("shrink-0 text-[11px]", statusTone(candidate.status))}>{candidate.status}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="flex items-center gap-2 pb-4 text-[11px] text-ink-secondary">
          <CheckCircle2 size={14} /> Provider completion produces an unverified task receipt. Only separately host-checked evidence may become a verified observation; models and policy are never rewritten automatically.
        </div>
      </div>
    </main>
  );
}
