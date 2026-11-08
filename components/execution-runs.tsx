"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Play, RefreshCw } from "lucide-react";
import type { ExecutionEvent, ExecutionPolicy, ExecutionRun, ExecutionRunDetail, ExecutionSnapshot } from "@/lib/execution-types";
import { localApi } from "@/lib/client-api";
import { errorText } from "@/lib/error-text";
import { useWorkspace } from "./workspace-context";
import { ExecutionPolicyEditor } from "./execution-policy-editor";
import { ConfirmButton } from "./confirm-button";
import { executionActive, executionQuery, executionTime, useExecution, type ExecutionAction, type ExecutionScope } from "./use-execution";

export function IssueExecution({ sessionToken, projectId, taskId, canEdit }: { sessionToken: string; projectId: string; taskId: string; canEdit: boolean }) {
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  return <section className="issue-execution"><button type="button" className="ghost-button compact" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Play size={14} />Develop / runs</button>
    {open && <IssueExecutionPanel key={taskId} scope={{ teamId: workspace._id, projectId, taskId, sessionToken }} canEdit={canEdit} />}
  </section>;
}

function IssueExecutionPanel({ scope, canEdit }: { scope: ExecutionScope; canEdit: boolean }) {
  const { data, error, busy, act, refresh } = useExecution(scope);
  const [overrides, setOverrides] = useState(false);
  const [started, setStarted] = useState(false);
  const start = async (policy?: ExecutionPolicy) => { setStarted(false); await act("startRun", policy ? { overrides: policy } : {}); setStarted(true); };
  return <div className="execution-panel">
    {error && <p className="notice danger" role="alert">{error}</p>}
    {!data ? <p className="execution-help" role="status">{error ? "Execution is unavailable." : "Loading run configuration…"}<button type="button" className="icon-button" aria-label="Refresh run configuration" onClick={refresh}><RefreshCw size={14} /></button></p> : <>
      <p className="execution-help">Develop runs the issue in an isolated repository worktree with the configured verification and smoke commands. The saved issue description is the task prompt. Credentials stay scoped to the approved environment.</p>
      <div className="execution-actions"><button type="button" className="primary-button compact" disabled={busy || !canEdit || !data.permissions.write || !data.effectivePolicy.fallback.length || data.runs.some(run => executionActive(run.status))} onClick={() => { void start().catch(() => {}); }}><Play size={14} />Develop</button><button type="button" className="ghost-button compact" aria-expanded={overrides} onClick={() => setOverrides(value => !value)}>Task overrides</button></div>
      {!data.effectivePolicy.fallback.length && <p className="notice">Choose an account, supported harness and reported model in task overrides or project automation settings before starting.</p>}
      {started && <p className="notice success" role="status">Run requested. Follow the actual queue and execution state below.</p>}
      {overrides && <ExecutionPolicyEditor data={data} scope="task" busy={busy || !canEdit || data.runs.some(run => executionActive(run.status))} act={act} onStart={start} />}
      <ExecutionRuns data={data} scope={scope} busy={busy} act={act} />
    </>}
  </div>;
}

export function ExecutionRuns({ data, scope, busy, act }: { data: ExecutionSnapshot; scope: ExecutionScope; busy: boolean; act: ExecutionAction }) {
  const [selected, setSelected] = useState<string | null>(null);
  const run = data.runs.find(item => item.id === selected);
  return <section className="settings-group"><h4>{scope.taskId ? "Issue runs" : "Recent runs · task usage"}</h4>
    {!data.runs.length && <p className="settings-empty">No runs recorded in this scope.</p>}
    <div className="execution-run-list">{data.runs.map(item => <button type="button" className={`execution-run-choice${item.id === selected ? " active" : ""}`} aria-expanded={item.id === selected} key={item.id} onClick={() => setSelected(item.id === selected ? null : item.id)}><strong>{item.title || item.id}</strong><span>{item.status.replaceAll("_", " ")}</span><small>{executionTime(item.createdAt)} · {item.usage.inputTokens.toLocaleString()} in / {item.usage.outputTokens.toLocaleString()} out tokens · API estimate {item.usage.estimatedApiUsd === null ? "not reported" : `$${item.usage.estimatedApiUsd.toFixed(4)}`}</small></button>)}</div>
    {run && <RunDetails key={run.id} initial={run} scope={scope} canWrite={data.permissions.write} busy={busy} act={act} />}
  </section>;
}

function RunDetails({ initial, scope, canWrite, busy, act }: { initial: ExecutionRun; scope: ExecutionScope; canWrite: boolean; busy: boolean; act: ExecutionAction }) {
  const [run, setRun] = useState(initial);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [messageSent, setMessageSent] = useState(false);
  const [revision, setRevision] = useState(0);
  const [following, setFollowing] = useState(true);
  const logs = useRef<HTMLPreElement>(null);
  const cursor = useRef(0);
  const { teamId, projectId, taskId, sessionToken } = scope;
  const active = executionActive(run.status);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let request: AbortController | undefined;
    const load = async () => {
      clearTimeout(timer);
      if (!alive || document.hidden) return;
      request?.abort(); request = new AbortController();
      const query = executionQuery({ teamId, projectId, taskId });
      query.set("runId", initial.id); query.set("cursor", String(cursor.current));
      try {
        const result = await localApi<ExecutionRunDetail>(`/api/execution?${query}`, sessionToken, { signal: request.signal });
        if (!alive) return;
        setRun(result.run); setError("");
        setEvents(current => { const known = new Set(current.map(event => event.id)); return [...current, ...result.events.filter(event => !known.has(event.id))]; });
        cursor.current = result.nextCursor;
      } catch (issue) {
        if (alive && !(issue instanceof Error && issue.name === "AbortError")) setError(errorText(issue, "Could not load run events"));
      } finally { if (alive && !document.hidden) timer = window.setTimeout(load, active ? 2000 : 15000); }
    };
    const visible = () => { if (document.hidden) { clearTimeout(timer); request?.abort(); } else void load(); };
    void load(); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; request?.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [teamId, projectId, taskId, sessionToken, initial.id, active, revision]);
  useEffect(() => { if (following && logs.current) logs.current.scrollTop = logs.current.scrollHeight; }, [events, following]);
  const control: ExecutionAction = async (action, payload) => { const result = await act(action, { ...payload, runId: run.id }); setRevision(value => value + 1); return result; };
  return <article className="execution-card execution-run-detail">
    <div className="execution-card-head"><h4>{run.status.replaceAll("_", " ")}</h4><button type="button" className="icon-button" aria-label="Refresh run details" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /></button></div>
    {error && <p className="notice danger" role="alert">{error}</p>}
    <p className="execution-help">Run {run.id} · attempt {run.attempt} · {run.selection ? `${run.selection.harness} / ${run.selection.model}${run.selection.effort ? ` / ${run.selection.effort}` : ""} · account ${run.selection.accountId}` : "Selection pending"}</p>
    <p className="execution-help">Machine: {run.hostId ?? "Not assigned"} · branch {run.branch || "Pending"} → {run.baseBranch} · environment {run.environment || "No injected secrets"}</p>
    {run.herdr && <section className="execution-receipt"><h4>Herdr · Origin task console</h4><p className="execution-help">Last reported console: <code>{run.herdr.name}</code> on the assigned machine · terminal <code>{run.herdr.terminalId}</code> · core <code>{run.herdr.coreId}</code> · session <code>{run.herdr.session}</code> · {executionTime(run.herdr.updatedAt)}. It may have closed since this report.</p><p className="execution-help">Shows task progress and accepts follow-ups or <code>/cancel</code>; this is not the coding CLI’s native interactive screen. Closing the console detaches it without stopping the task. Tool approvals remain in Origin; Hermes cannot access personal terminals.</p></section>}
    {run.reason && <p className="notice" role="status">{run.reason}</p>}{run.summary && <p className="execution-summary">{run.summary}</p>}
    <dl className="execution-statistics"><div><dt>Input tokens</dt><dd>{run.usage.inputTokens.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{run.usage.outputTokens.toLocaleString()}</dd></div><div><dt>Estimated API cost</dt><dd>{run.usage.estimatedApiUsd === null ? "Not reported" : `$${run.usage.estimatedApiUsd.toFixed(4)}`}</dd></div></dl>
    <p className="execution-help">Token counts are task telemetry, not subscription plan capacity. API estimates are not an invoice or a hard spend cap.</p>
    {run.checkpoint && <p className="execution-help">Checkpoint: <code>{run.checkpoint.sha}</code>{run.checkpoint.summary ? ` · ${run.checkpoint.summary}` : ""}</p>}
    <section className="execution-receipt"><h4>Verification & GitHub merge</h4>
      {!run.verification.length && <p className="execution-help">No verification result reported.</p>}
      {run.verificationOnly && <p className="execution-help">Revalidating this worktree against updated {run.baseBranch}; no additional model turn is requested.</p>}
      {run.verifiedBaseSha && <p className="execution-help">Verified base: <code>{run.verifiedBaseSha}</code></p>}
      {run.verification.map((check, index) => <div key={index}><code>{check.command}</code><span className="execution-badge">{check.kind} · exit {check.exitCode}</span>{check.summary && <p className="execution-help">{check.summary}</p>}</div>)}
      <p className="execution-help">Merge: {run.merge ? run.merge.state.replaceAll("_", " ") : "Not reported"}{run.merge?.reason ? ` · ${run.merge.reason}` : ""}</p>
      {run.merge?.url && <a href={run.merge.url} target="_blank" rel="noreferrer">View pull request{run.merge.number ? ` #${run.merge.number}` : ""}</a>}
      {run.merge?.mergeSha && <p className="execution-help">Merged commit: <code>{run.merge.mergeSha}</code></p>}
    </section>
    <section className="execution-receipt"><h4>Deployment · separate evidence</h4>
      <p className="execution-help">{run.deployment.status.replaceAll("_", " ")}{run.deployment.environment ? ` · ${run.deployment.environment}` : ""}{run.deployment.message ? ` · ${run.deployment.message}` : ""}</p>
      {run.deployment.mergeSha && <p className="execution-help">Deployment commit: <code>{run.deployment.mergeSha}</code></p>}
      <p className="execution-help">{run.deployment.evidenceAt ? `GitHub event ${executionTime(run.deployment.evidenceAt)}` : "No deployment event confirmed"}{run.deployment.observedAt ? ` · Last checked ${executionTime(run.deployment.observedAt)}` : ""}</p>
      {run.deployment.url && <a href={run.deployment.url} target="_blank" rel="noreferrer">Deployment evidence</a>}
      <p className="execution-help">A successful coding run or merged PR does not imply the application was deployed.</p>
    </section>
    {run.approvals.length > 0 && <section className="execution-receipt"><h4>Tool approvals</h4>{run.approvals.map(approval => <article className="execution-card" key={approval.id}><strong>{approval.tool}</strong><pre className="execution-approval">{JSON.stringify(approval.input, null, 2)}</pre>{approval.decision ? <p className="execution-help">Decision: {approval.decision} · {executionTime(approval.decidedAt)}</p> : <div className="execution-actions"><button type="button" className="ghost-button compact" disabled={busy || !canWrite || !active} onClick={() => { void control("approve", { approvalId: approval.id, decision: "deny" }).catch(() => {}); }}>Deny</button><ConfirmButton className="primary-button compact" label={`Allow ${approval.tool}`} text="Allow" confirmLabel="Confirm allow" disabled={busy || !canWrite || !active} onConfirm={() => { void control("approve", { approvalId: approval.id, decision: "allow" }).catch(() => {}); }} /></div>}</article>)}</section>}
    <div className="execution-card-head"><h4>Logs & messages</h4><label className="execution-inline-check"><input type="checkbox" checked={following} onChange={event => setFollowing(event.target.checked)} />Follow</label></div>
    <pre className="execution-logs" ref={logs} tabIndex={0} aria-label="Run logs and events">{events.length ? events.map(event => `[${executionTime(event.createdAt)}] ${event.stream ?? event.type}: ${event.text ?? JSON.stringify(event.data ?? {})}`).join("\n") : "No events received."}</pre>
    {active && canWrite && <form className="settings-form" onSubmit={async event => { event.preventDefault(); setMessageSent(false); try { await control("messageRun", { text: message }); setMessage(""); setMessageSent(true); } catch { /* Parent displays errors. */ } }}><label>Message the running agent<textarea rows={2} maxLength={16000} required value={message} onChange={event => setMessage(event.target.value)} placeholder="Guidance for this task; never paste credentials" /></label><div className="execution-actions"><button className="ghost-button compact" disabled={busy || !message.trim()}>Send message</button><ConfirmButton className="ghost-button compact danger" label="Cancel execution run" text="Cancel run" confirmLabel="Confirm cancel" disabled={busy} onConfirm={() => { void control("cancelRun").catch(() => {}); }} /></div></form>}
    {messageSent && <p className="notice success" role="status">Message queued for the runner. Delivery is reflected in the event stream.</p>}
    <p className="execution-help">Process stopped: {run.processStopped ? "Confirmed" : "Not confirmed"}. Cancellation requests wait for the worker to stop; disconnects are not proof of a stopped process.</p>
  </article>;
}
