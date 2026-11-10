import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { Routine } from "@/lib/routines";

type Step = { kind: string; id: string; tool?: string; input?: Record<string, unknown>; from?: string; where?: unknown; pagination?: { maxPages: number }; steps?: Step[]; otherwise?: Step[] };
type Proposal = { plan: { steps: Step[]; output?: unknown }; fingerprint: string; verified: boolean; approved: boolean };
type Request = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

function Steps({ steps }: { steps: Step[] }) {
  return <ol className="space-y-2">{steps.map((step) => <li key={step.id} className="rounded-lg border border-hairline/50 bg-inset p-3 text-[13px]">
    <div className="font-medium text-ink">{step.kind === "call" ? step.tool : step.kind === "each" ? t("routines.minimumAi.each", { source: step.from ?? "" }) : t("routines.minimumAi.condition")} <span className="text-ink-secondary">({step.id})</span></div>
    {step.where != null && <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-ink-secondary">{JSON.stringify(step.where, null, 2)}</pre>}
    {step.input && Object.keys(step.input).length > 0 && <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-ink-secondary">{JSON.stringify(step.input, null, 2)}</pre>}
    {step.pagination && <div className="mt-2 text-[12px] text-ink-secondary">{t("routines.minimumAi.pages", { count: step.pagination.maxPages })}</div>}
    {step.steps && <div className="mt-2"><Steps steps={step.steps} /></div>}
    {step.otherwise && <div className="mt-2"><div className="mb-2 text-[12px] text-ink-secondary">{t("routines.minimumAi.otherwise")}</div><Steps steps={step.otherwise} /></div>}
  </li>)}</ol>;
}

export function MinimumAiReview({ routineId, loadExisting = false, request, onDone, onClose }: { routineId: string; loadExisting?: boolean; request: Request; onDone: (routine: Routine) => void; onClose: () => void }) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [accounts, setAccounts] = useState<Array<{ service: string; name: string }>>([]);
  const [interrupted, setInterrupted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [recordConfirmed, setRecordConfirmed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, () => { if (!busy) onClose(); });
  const base = `/api/routines/${routineId}/minimum-ai`;
  useEffect(() => {
    let active = true;
    setBusy(true);
    void (async () => {
      const recovery = await request<{ interrupted: boolean }>(`${base}/recovery`);
      if (active) setInterrupted(recovery.interrupted);
      if (loadExisting) {
        try {
          const response = await request<{ workflow: Proposal; accounts?: Array<{ service: string; name: string }>; interrupted?: boolean }>(base);
          if (active) { setProposal(response.workflow); setAccounts(response.accounts ?? []); setInterrupted(response.interrupted === true); }
        } catch (cause) { if (active && !recovery.interrupted) setError(cause instanceof Error ? cause.message : String(cause)); }
      }
    })().catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [base, loadExisting, request]);
  const action = async (kind: "prepare" | "record" | "test" | "approve" | "acknowledge") => {
    setBusy(true); setError(""); setResult("");
    try {
      const response = await request<{ workflow: Proposal; interrupted?: boolean; accounts?: Array<{ service: string; name: string }>; result?: { status: string; error?: string; partial?: boolean; completed?: string[]; unexercised?: string[]; output?: unknown } }>(`${base}/${kind}`, { method: "POST", body: JSON.stringify(kind === "prepare" ? {} : kind === "acknowledge" || kind === "record" ? { confirm: true } : { fingerprint: proposal?.fingerprint }) });
      setProposal(response.workflow);
      setAccounts(response.accounts ?? []);
      setInterrupted(response.interrupted === true);
      if (kind === "record") setResult(t("routines.minimumAi.recorded"));
      if (response.result?.status === "failed") { setError(response.result.error ?? t("routines.minimumAi.testFailed")); if (response.result.partial) setResult(t("routines.minimumAi.partial")); }
      if (response.result?.status === "completed") setResult(`${t("routines.minimumAi.testPassed")} ${t("routines.minimumAi.completedSteps", { steps: response.result.completed?.join(", ") || "—" })}${response.result.unexercised?.length ? `\n${t("routines.minimumAi.untestedSteps", { steps: response.result.unexercised.join(", ") })}` : ""}${response.result.output === undefined ? "" : `\n${t("routines.minimumAi.output")} ${JSON.stringify(response.result.output).slice(0, 2_000)}`}`);
      if (kind === "approve") {
        const saved = await request<{ routine: Routine }>(`/api/routines/${routineId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
        onDone(saved.routine);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("routines.minimumAi.reviewTitle")} tabIndex={-1} className="max-h-[90vh] w-full max-w-[680px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel p-6 shadow-2xl">
      <h2 className="text-[17px] font-semibold text-ink">{t("routines.minimumAi.reviewTitle")}</h2>
      <p className="mt-2 text-[13px] text-ink-secondary">{t("routines.minimumAi.reviewIntro")}</p>
      {interrupted && <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[12px] text-warning"><p>{t("routines.minimumAi.interrupted")}</p><button type="button" disabled={busy} onClick={() => void action("acknowledge")} className="mt-2 rounded-lg border border-warning/40 px-3 py-2 disabled:opacity-40">{t("routines.minimumAi.acknowledge")}</button></div>}
      {!proposal && <div className="mt-5 space-y-4"><button type="button" disabled={busy || interrupted} onClick={() => void action("prepare")} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40">{t(busy ? "routines.minimumAi.working" : "routines.minimumAi.prepare")}</button><div className="rounded-lg border border-hairline/50 p-3"><p className="text-[12px] text-warning">{t("routines.minimumAi.recordWarning")}</p><label className="mt-3 flex items-start gap-2 text-[12px] text-ink-secondary"><input type="checkbox" checked={recordConfirmed} onChange={(event) => setRecordConfirmed(event.target.checked)} disabled={busy} />{t("routines.minimumAi.recordConfirm")}</label><button type="button" disabled={busy || interrupted || !recordConfirmed} onClick={() => void action("record")} className="mt-3 rounded-lg border border-hairline/60 px-4 py-2 text-[13px] text-ink disabled:opacity-40">{t("routines.minimumAi.record")}</button></div></div>}
      {proposal && <div className="mt-5 space-y-4"><div className="text-[12px] text-ink-secondary">{t("routines.minimumAi.accounts")} {accounts.map((account) => `${account.service}: ${account.name}`).join(", ")}</div><Steps steps={proposal.plan.steps} />{proposal.plan.output !== undefined && <div className="text-[12px] text-ink-secondary">{t("routines.minimumAi.output")} <code>{JSON.stringify(proposal.plan.output)}</code></div>}<p className="text-[12px] text-warning">{t(proposal.plan.steps.some((step) => step.tool?.startsWith("MINAI_BROWSER_")) ? proposal.plan.steps.some((step) => step.kind === "each") ? "routines.minimumAi.recorded" : "routines.minimumAi.fixedWarning" : "routines.minimumAi.testWarning")}</p>
        <div className="flex flex-wrap gap-2">{!proposal.plan.steps.some((step) => step.tool?.startsWith("MINAI_BROWSER_")) && <button type="button" disabled={busy || interrupted} onClick={() => void action("test")} className="rounded-lg border border-hairline/60 px-4 py-2 text-[13px] text-ink disabled:opacity-40">{t(busy ? "routines.minimumAi.working" : "routines.minimumAi.test")}</button>}
          <button type="button" disabled={busy || interrupted} onClick={() => void action("prepare")} className="rounded-lg border border-hairline/60 px-4 py-2 text-[13px] text-ink disabled:opacity-40">{t("routines.minimumAi.regenerate")}</button>
          <button type="button" disabled={busy || interrupted || !proposal.verified} onClick={() => void action("approve")} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40">{t("routines.minimumAi.approve")}</button></div></div>}
      {result && <p role="status" className="mt-4 whitespace-pre-wrap break-words text-[13px] text-ink-secondary">{result}</p>}
      {error && <p role="alert" className="mt-4 text-[13px] text-danger">{error}</p>}
      <div className="mt-6 flex justify-end"><button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised disabled:opacity-40">{t("routines.minimumAi.close")}</button></div>
    </div>
  </div>;
}
