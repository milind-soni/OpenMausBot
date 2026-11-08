"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { localApi } from "@/lib/client-api";
import { errorText } from "@/lib/error-text";
import type { ExecutionSnapshot } from "@/lib/execution-types";

export type ExecutionScope = { teamId: string; projectId?: string; taskId?: string; sessionToken: string };
export type ExecutionAction = (action: string, payload?: Record<string, unknown>) => Promise<unknown>;
export const executionActive = (status: string) => !["succeeded", "merged", "failed", "cancelled"].includes(status);
export const executionTime = (value?: number | null) => value ? new Date(value).toLocaleString() : "Not reported";

export function executionQuery(scope: Omit<ExecutionScope, "sessionToken">) {
  const query = new URLSearchParams({ teamId: scope.teamId });
  if (scope.projectId) query.set("projectId", scope.projectId);
  if (scope.taskId) query.set("taskId", scope.taskId);
  return query;
}

/** Mounted panels alone subscribe; hidden browser tabs do not poll. Mutations never repeat automatically. */
export function useExecution(scope: ExecutionScope) {
  const { teamId, projectId, taskId, sessionToken } = scope;
  const [data, setData] = useState<ExecutionSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mutation = useRef(false);
  const active = Boolean(data?.runs.some(run => executionActive(run.status)));
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let request: AbortController | undefined;
    const load = async () => {
      clearTimeout(timer);
      if (document.hidden || !alive) return;
      request?.abort();
      request = new AbortController();
      try {
        const result = await localApi<ExecutionSnapshot>(`/api/execution?${executionQuery({ teamId, projectId, taskId })}`, sessionToken, { signal: request.signal });
        if (alive) { setData(result); setError(""); }
      } catch (issue) {
        if (alive && !(issue instanceof Error && issue.name === "AbortError")) setError(errorText(issue, "Could not load execution status"));
      } finally {
        if (alive && !document.hidden) timer = window.setTimeout(load, active ? 2000 : 15000);
      }
    };
    const visible = () => { if (document.hidden) { clearTimeout(timer); request?.abort(); } else void load(); };
    void load();
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearTimeout(timer); request?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [teamId, projectId, taskId, sessionToken, revision, active]);
  const act = useCallback<ExecutionAction>(async (action, payload = {}) => {
    if (mutation.current) throw new Error("Wait for the current action to finish.");
    mutation.current = true; setBusy(true); setError("");
    try {
      const result = await localApi<unknown>("/api/execution", sessionToken, { method: "POST", json: { ...payload, teamId, projectId, taskId, action } });
      refresh();
      return result;
    } catch (issue) {
      setError(errorText(issue, "Execution action failed"));
      throw issue;
    } finally { mutation.current = false; setBusy(false); }
  }, [teamId, projectId, taskId, sessionToken, refresh]);
  return { data, error, busy, act, refresh };
}
