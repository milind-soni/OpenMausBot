"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
import { executionTime } from "./use-execution";

export function GitHubSyncStatus({ projectId, taskId, task, sessionToken, canEdit }: { projectId: Id<"projects">; taskId?: Id<"tasks">; task?: { title: string; githubSyncState?: string; githubSyncError?: string; updatedAt: number }; sessionToken: string; canEdit: boolean }) {
  const rows = useQuery(api.githubLifecycle.status, taskId ? "skip" : { sessionToken, projectId });
  const retry = useMutation(api.githubLifecycle.retry);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const shown = taskId ? task?.githubSyncState ? [{ taskId, title: task.title, deleted: false, state: task.githubSyncState, error: task.githubSyncError, updatedAt: task.updatedAt }] : [] : rows?.filter(row => row.state !== "synced") ?? [];
  if (!shown.length && !error) return null;
  return <section className="execution-sync" aria-label="GitHub issue synchronization"><h4>GitHub issue sync</h4>{error && <p className="notice danger" role="alert">{error}</p>}{shown.map(row => <div className="execution-card" key={row.taskId}><div className="execution-card-head"><strong>{row.deleted ? "Deletion" : "Issue"}: {row.title}</strong><span className="execution-badge">{row.state}</span></div>{row.error && <p className="notice danger" role="alert">{row.error}</p>}<p className="execution-help">{row.deleted ? "The Origin issue is removed. Its GitHub deletion remains tracked until confirmed; closing it is not deletion." : "Draft issues are included in GitHub synchronization."} Updated {executionTime(row.updatedAt)}.</p>{canEdit && ["pending", "error"].includes(row.state) && <button type="button" className="ghost-button compact" disabled={Boolean(busy)} onClick={async () => { setBusy(row.taskId); setError(""); try { await retry({ sessionToken, projectId, taskId: row.taskId }); } catch (issue) { setError(errorText(issue, "Could not retry GitHub synchronization")); } finally { setBusy(null); } }}>{busy === row.taskId ? "Retrying…" : "Retry sync"}</button>}</div>)}</section>;
}
