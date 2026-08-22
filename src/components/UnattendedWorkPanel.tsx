import { useCallback, useEffect, useState } from "react";
import { Activity, Send } from "lucide-react";

import { buildOpenMausWorkRequest, type WorkRequestFields } from "@/lib/unattended-work";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const INITIAL_FIELDS: WorkRequestFields = {
  repository: "",
  issue: "",
  repoPath: "",
  baselineSha: "",
  taskBranch: "codex/",
  allowedPaths: "",
  acceptanceTests: "",
  tokenBudget: "12000",
  maxRuntimeSeconds: "3600",
};

interface AdapterHealth {
  adapter?: { enabled?: boolean; executor?: string; runs_repo_tools?: boolean; uses_full_task_profile?: boolean };
  plane?: { dormant_ready?: boolean; live_accepted?: boolean } | null;
  status?: string;
}

interface WorkResult {
  error?: string;
  pass?: boolean;
  request?: { id?: string };
  schema?: string;
  status?: string;
}

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

export function UnattendedWorkPanel() {
  const [fields, setFields] = useState(INITIAL_FIELDS);
  const [health, setHealth] = useState<AdapterHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<WorkResult | null>(null);
  const [requestId, setRequestId] = useState("");

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api("/api/unattended-work/health"));
      setHealthError("");
    } catch (error) {
      setHealth(null);
      setHealthError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const set = (name: keyof WorkRequestFields, value: string) =>
    setFields((current) => ({ ...current, [name]: value }));
  const enabled = health?.adapter?.enabled === true;

  const submit = async () => {
    setWorking(true);
    try {
      const response: WorkResult = await api("/api/unattended-work", {
        method: "POST",
        body: JSON.stringify(buildOpenMausWorkRequest(fields)),
      });
      setResult(response);
      const id = response.request?.id;
      if (id) setRequestId(id);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(false);
    }
  };

  const checkStatus = async () => {
    setWorking(true);
    try {
      const response: WorkResult = await api(`/api/unattended-work/${encodeURIComponent(requestId.trim())}`);
      setResult(response);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Hermes work plane"
        subtitle="Submission and status only. OpenMausBot never runs repository tools or selects the broad full-task profile."
      >
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className={`rounded-full px-2.5 py-1 ${enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary"}`}>
            {healthError ? "Unavailable" : enabled ? "Ingress enabled" : "Dormant / disabled"}
          </span>
          <span className="text-ink-secondary">Executor: Hermes</span>
          <button
            type="button"
            onClick={() => void refreshHealth()}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-ink hover:bg-raised"
          >
            <Activity size={13} /> Refresh
          </button>
        </div>
        {healthError && <div className="mt-2 text-[12px] text-danger">{healthError}</div>}
      </Card>

      <Card
        title="Submit guarded work"
        subtitle="Exact baseline, isolated worktree, task branch, allowed paths, acceptance commands, and owning issue are required. Invalid requests stay in triage."
      >
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Repository owner and name" className={inputClass} value={fields.repository} onChange={(e) => set("repository", e.target.value)} placeholder="owner/repository" />
          <input aria-label="Owning issue number" className={inputClass} value={fields.issue} onChange={(e) => set("issue", e.target.value)} placeholder="Issue number" inputMode="numeric" />
          <input aria-label="Isolated repository worktree path" className="col-span-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none" value={fields.repoPath} onChange={(e) => set("repoPath", e.target.value)} placeholder="/absolute/path/to/isolated-worktree" />
          <input aria-label="Baseline Git commit SHA" className={inputClass} value={fields.baselineSha} onChange={(e) => set("baselineSha", e.target.value)} placeholder="40-character baseline SHA" />
          <input aria-label="Task branch name" className={inputClass} value={fields.taskBranch} onChange={(e) => set("taskBranch", e.target.value)} placeholder="codex/task-branch" />
          <textarea aria-label="Allowed repository paths" className={`${inputClass} min-h-24 resize-y`} value={fields.allowedPaths} onChange={(e) => set("allowedPaths", e.target.value)} placeholder={"Allowed paths, one per line\nsrc/\ntests/"} />
          <textarea aria-label="Acceptance test commands" className={`${inputClass} min-h-24 resize-y`} value={fields.acceptanceTests} onChange={(e) => set("acceptanceTests", e.target.value)} placeholder={"Acceptance commands, one per line\npnpm typecheck\npnpm test"} />
          <input aria-label="Token budget" className={inputClass} value={fields.tokenBudget} onChange={(e) => set("tokenBudget", e.target.value)} placeholder="Token budget" inputMode="numeric" />
          <input aria-label="Maximum runtime in seconds" className={inputClass} value={fields.maxRuntimeSeconds} onChange={(e) => set("maxRuntimeSeconds", e.target.value)} placeholder="Runtime seconds (max 7200)" inputMode="numeric" />
        </div>
        <button
          type="button"
          disabled={!enabled || working}
          onClick={() => void submit()}
          className="mt-3 flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          <Send size={13} /> Submit one request
        </button>
      </Card>

      <Card title="Work status" subtitle="Read one request by its deterministic work ID.">
        <div className="flex gap-2">
          <input aria-label="Work request ID" className={inputClass} value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="work-…" />
          <button type="button" disabled={!enabled || working || !requestId.trim()} onClick={() => void checkStatus()} className="shrink-0 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-40">
            Check status
          </button>
        </div>
        {result && (
          <pre className="mt-3 max-h-52 overflow-auto rounded-lg bg-inset p-3 text-[11px] text-ink-secondary">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  );
}
