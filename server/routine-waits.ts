// A routine run that asks the person something waits for them: its run limit bounds active work only, and an
// approval nobody answered ends the run with that reason. The engines' own prompts stay the only gates.
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoutineRun } from "./routines.ts";

type Opened = RuntimeEvent & { type: "request.opened" };
type Resolved = RuntimeEvent & { type: "request.resolved" };

/** The open request a run waits on, from when it opened. */
export interface RoutineRunAsk {
  requestId?: string;
  approval: boolean;
  /** "to use COMPOSIO_SEARCH_TOOLS", "to run “ls”", or the question asked. */
  subject: string;
  since: number;
}

// ACP permission kinds and the drivers' generic names say nothing about which tool asked.
const GENERIC_TOOLS = new Set(["edit", "tool", "mcp", "other", "permissions", "read", "fetch", "search", "delete", "move", "think"]);
const SHELL_TOOLS = new Set(["shell", "bash", "execute"]);

const plain = (text: string, max: number) => {
  const line = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

function approvalSubject(tool: string, summary: string): string {
  const named = tool.startsWith("mcp__") ? tool.split("__").slice(2).join("__") : tool;
  const what = plain(summary, 120) || named || "an action";
  if (SHELL_TOOLS.has(named.toLowerCase())) return `to run “${what}”`;
  return named && !GENERIC_TOOLS.has(named.toLowerCase()) ? `to use ${plain(named, 80)}` : `for “${what}”`;
}

export function askOf(event: Opened, now: number): RoutineRunAsk {
  const approval = event.requestType === "permission" && !event.questions?.length;
  return {
    ...(event.requestId ? { requestId: event.requestId } : {}),
    approval,
    subject: approval ? approvalSubject(event.tool, event.summary) : plain(event.summary, 500),
    since: now,
  };
}

/** What the run's card and the Routines log show while it waits. */
export function waitingFor(ask: RoutineRunAsk): string | undefined {
  return ask.approval ? `Waiting for your approval ${ask.subject}` : ask.subject || undefined;
}

/** Ends the run's wait on the person. Returns why the run stops when an approval closed with nobody's answer. */
export function settleAsk(run: RoutineRun, event: Resolved | undefined, now: number): string | null {
  const ask = run.asked;
  if (!ask || (event && ask.requestId && event.requestId && event.requestId !== ask.requestId)) return null;
  run.waitedMs = (run.waitedMs ?? 0) + Math.max(0, now - ask.since);
  delete run.asked;
  return ask.approval && event?.source === "timeout" ? `Stopped: nobody answered the approval ${ask.subject}` : null;
}

/** Time the run has worked: waiting on the person never counts toward its limit. */
export function activeMs(run: RoutineRun, now: number): number {
  return now - (run.startedAt ?? now) - (run.waitedMs ?? 0) - (run.asked ? Math.max(0, now - run.asked.since) : 0);
}
