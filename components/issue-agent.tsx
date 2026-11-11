"use client";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { Bot } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
import { formatDateTime, formatRelative } from "@/lib/format";
import { IssueSelect } from "./issue-select";

// Agents on an issue, after Linear's assign/delegate model: the human assignee stays; an agent can be delegated to
// work the issue. Delegating starts nothing by itself — the agent hears about it (issue.delegated webhook, get_inbox)
// and the standing rule applies: refine with the owner first, build only after they confirm.

/** The Agent row on the issue: who the issue is delegated to. Lists connections their owners marked as taking issues. */
export function IssueDelegate({ sessionToken, projectId, taskId, delegateId, delegateName, disabled, onError }: {
  sessionToken: string; projectId: Id<"projects">; taskId: Id<"tasks">;
  delegateId?: Id<"connectorGrants">; delegateName?: string; disabled?: boolean; onError: (message: string) => void;
}) {
  const agents = useQuery(api.issueActivity.agents, { sessionToken, projectId });
  const delegate = useMutation(api.issueActivity.delegate);
  const options = [
    { value: "", label: "No agent", icon: <Bot size={14} /> },
    ...(agents ?? []).map(agent => ({ value: agent.id as string, label: agent.name, icon: <AgentMark /> })),
    // A delegate whose connection was since unlisted still shows by name until someone changes it.
    ...(delegateId && agents && !agents.some(agent => agent.id === delegateId) ? [{ value: delegateId as string, label: delegateName ?? "Agent", icon: <AgentMark /> }] : []),
  ];
  return <IssueSelect label="Agent" caption="Delegate to agent" icon={delegateId ? <AgentMark /> : <Bot size={14} />} placeholder="No agent" value={delegateId ?? ""} options={options} disabled={disabled || agents === undefined}
    onChange={value => void delegate({ sessionToken, projectId, taskId, grantId: (value || null) as Id<"connectorGrants"> | null }).catch(error => onError(errorText(error, "Could not delegate the issue")))} />;
}

/** Agents read as agents: a squared badge with a bot glyph, never a person's round avatar. */
export function AgentMark({ size = 14 }: { size?: number }) {
  return <span className="agent-mark" style={{ width: size + 2, height: size + 2 }} aria-hidden="true"><Bot size={size - 3} /></span>;
}

const VERB: Record<string, (row: ActivityRow) => ReactNode> = {
  delegated: row => <>delegated to <strong className="agent-name">{row.to}</strong></>,
  undelegated: row => <>took the issue back from <strong className="agent-name">{row.from}</strong></>,
  acknowledged: () => <>acknowledged the issue</>,
  progress: () => <>reported progress</>,
  question: () => <>asked a question</>,
  blocked: () => <>is blocked</>,
  done: () => <>finished its part</>,
  commented: () => <>commented</>,
  status: row => <>moved it from {row.from ?? "—"} to {row.to ?? "—"}</>,
  updated: () => <>updated the issue</>,
  created: () => <>created the issue</>,
  criteria: () => <>changed acceptance criteria</>,
};
type ActivityRow = { id: string; kind: string; actorName: string; agentName: string | null; from: string | null; to: string | null; body: string | null; createdAt: number };

/** Activity entries for the issue timeline, each with its time so the caller can merge them with comments. */
export function useIssueActivity(sessionToken: string, projectId: Id<"projects">, taskId: Id<"tasks">): { at: number; node: ReactNode }[] {
  const rows = useQuery(api.issueActivity.list, { sessionToken, projectId, taskId });
  return (rows ?? []).map(row => {
    const agent = row.agentName && row.kind !== "delegated" && row.kind !== "undelegated";
    return {
      at: row.createdAt,
      node: <div className="issue-timeline-event agent-activity" data-kind={row.kind} key={`activity-${row.id}`}>
        {row.agentName ? <AgentMark /> : <span aria-hidden="true" />}
        <div>
          <p>{agent ? <strong className="agent-name">{row.agentName}</strong> : <strong>{row.actorName}</strong>} {VERB[row.kind]?.(row) ?? row.kind}{agent ? <span className="agent-on-behalf"> for {row.actorName}</span> : null} <time dateTime={new Date(row.createdAt).toISOString()} title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time></p>
          {row.body && row.kind !== "commented" && <blockquote className="agent-activity-body">{row.body}</blockquote>}
        </div>
      </div>,
    };
  });
}
