import { createHash } from "node:crypto";

import type { Assignment } from "./runtime/types.ts";

export type JobScope = "job" | "turn";
import type { JobState } from "../shared/job-state.ts";
export { FINAL_JOB_STATES, type JobState } from "../shared/job-state.ts";

export interface ConversationState {
  kind: "bot" | "room";
  busy: boolean;
  activity?: string;
  queued: number;
}

export interface JobNode {
  id: string;
  rootId: string;
  parentId?: string;
  depth: number;
  botId: string;
  botName: string;
  threadId: string;
  threadTitle?: string;
  groupId?: string;
  status: Assignment["status"];
  outcome?: Assignment["outcome"];
  outcomeDetail?: string;
  disposition?: Assignment["disposition"];
  question?: string;
  mode: Assignment["mode"];
  reply: Assignment["reply"];
  awaited: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  executions: number;
  result?: string;
  /** Visible root's source request, normalized and bounded to 160 characters. */
  sourceRequest?: string;
}

export interface JobView {
  threadId: string;
  scope: JobScope;
  /** Work open at or begun after this server time is the job; pass it back to keep the same job. */
  since: number;
  now: number;
  state: JobState;
  reason: string;
  /** Changes whenever anything a waiter would report changes; pass it back to wait for the next change. */
  version: string;
  conversation: ConversationState;
  /** Most recent visible source job on the selected transcript branch, before node clipping. */
  current: {
    rootId: string;
    requestMessageId?: string;
    status: Assignment["status"];
    outcome?: Assignment["outcome"];
    state: JobState;
    reason: string;
    sourceRequest?: string;
    /** Legacy engine completion has no independently recorded task disposition. */
    legacyTaskOutcome?: true;
  } | null;
  /** Visible source jobs whose native execution still has no confirmed stop. */
  unconfirmedStops: Array<{ rootId: string; sourceRequest?: string }>;
  roots: string[];
  nodes: JobNode[];
  hidden: number;
  counts: Record<"queued" | "running" | "waiting" | "needsInput" | "completed" | "failed" | "cancelled", number>;
  needsInput: Array<{ id: string; botId: string; botName: string; threadId: string; question: string }>;
}

export interface JobInput {
  threadId: string;
  scope: JobScope;
  since: number;
  now: number;
  scopes: readonly string[];
  rows: readonly Assignment[];
  conversation: ConversationState;
  sourceBotId?: string;
  requestMessageIds?: ReadonlySet<string>;
  activityOf(row: Assignment): string | undefined;
  nameOf(botId: string): string | undefined;
  titleOf(row: Assignment): string | undefined;
  visible(threadId: string): boolean;
  full?: boolean;
}

const RESULT_CLIP = 280;
const NODES_SHOWN = 500;
const ended = (a: Assignment) => a.status === "completed" || a.status === "failed" || a.status === "cancelled";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const names = (rows: readonly Assignment[], label: (row: Assignment) => string) => {
  const unique = [...new Set(rows.map(label))];
  return unique.length > 3 ? `${unique.slice(0, 3).join(", ")} and ${unique.length - 3} more` : unique.join(", ");
};

function currentTasks(rows: readonly Assignment[]): Assignment[] {
  const latest = new Map<string, Assignment>();
  const superseded = new Set<string>();
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const key = JSON.stringify([row.parentId, row.assignee.botId, row.assignee.destination.threadId, row.assignee.destination.groupId, row.mode, row.brief]);
    const prior = latest.get(key);
    if (row.rework && prior && row.parentId) superseded.add(prior.id);
    latest.set(key, row);
  }
  return rows.filter(row => {
    const seen = new Set<string>();
    for (let node: Assignment | undefined = row; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
      if (superseded.has(node.id) || seen.has(node.id)) return false;
      seen.add(node.id);
    }
    return true;
  });
}

function jobState(input: JobInput) {
  const nameOf = (botId: string) => input.nameOf(botId) ?? botId;
  // The reason never names or quotes work in a conversation the reader may not open.
  const shows = (row: Assignment) => input.visible(row.assignee.destination.threadId);
  const label = (row: Assignment) => shows(row) ? nameOf(row.assignee.botId) : "a teammate";
  const byId = new Map(input.rows.map((row) => [row.id, row]));
  const starts = new Set(input.scopes);
  const awaited = new Map<string, boolean>();
  const counts = (row: Assignment): boolean => {
    const known = awaited.get(row.id);
    if (known !== undefined) return known;
    awaited.set(row.id, false);
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    const result = starts.has(row.id) || (row.reply !== "none" && parent !== undefined && !ended(parent) && counts(parent));
    awaited.set(row.id, result);
    return result;
  };
  const scoped = input.rows.filter((row) => starts.has(row.id));
  const live = input.scope === "turn"
    ? scoped.filter((row) => !ended(row) && row.status !== "waiting")
    : input.rows.filter((row) => !ended(row) && counts(row));
  const parked = live.filter((row) => row.status === "needs_input");
  const asking = live.filter((row) => row.status === "running" && input.activityOf(row) === "waiting-on-you");
  const { conversation } = input;
  const lead = scoped.at(-1);
  const leadName = lead ? nameOf(lead.assignee.botId) : conversation.kind === "room" ? "The room" : "The bot";

  let state: JobState;
  let reason: string;
  if (conversation.activity === "waiting-on-you" || parked.length || asking.length) {
    state = "needs-input";
    const first = parked[0] ?? asking[0];
    reason = !first ? `${leadName} is waiting for your answer in this conversation`
      : shows(first) ? `${nameOf(first.assignee.botId)} needs you: ${first.question ?? "an approval is waiting in its conversation"}`
      : "A teammate needs an answer in a conversation you cannot open";
  } else if (conversation.activity === "dead") {
    state = "failed";
    reason = `${leadName}'s engine stopped unexpectedly`;
  } else if (conversation.activity === "no-signal") {
    state = "stalled";
    reason = `No sign of progress from ${leadName}'s engine`;
  } else if (conversation.busy || conversation.queued > 0 || live.length) {
    state = "running";
    const teammates = live.filter((row) => !starts.has(row.id));
    reason = conversation.busy ? `${leadName} is working`
      : teammates.length ? `Waiting on ${plural(teammates.length, "teammate task", "teammate tasks")}: ${names(teammates, label)}`
      : conversation.queued > 0 ? "A message is waiting its turn"
      : `${leadName} is about to continue`;
  } else if (!lead) {
    state = "idle";
    reason = "Nothing is running in this conversation";
  } else if (lead.status === "cancelled") {
    state = "cancelled";
    reason = `${leadName} was stopped`;
  } else if (lead.disposition?.state === "blocked") {
    state = "blocked";
    reason = lead.disposition.reason;
  } else if (lead.status === "waiting") {
    state = "running";
    reason = `${leadName} is waiting to continue`;
  } else if (lead.status === "completed") {
    state = "completed";
    const children = currentTasks(input.rows).filter(row => row.rootId === lead.rootId && row.id !== lead.id && row.reply !== "none");
    const unresolved = children.filter(row => !ended(row));
    const blocked = children.find(row => row.disposition?.state === "blocked");
    const failed = children.filter(row => row.status === "failed" || row.status === "cancelled");
    if (unresolved.length) {
      state = unresolved.some(row => row.status === "needs_input") ? "needs-input" : "running";
      reason = `Waiting on ${plural(unresolved.length, "teammate task", "teammate tasks")}: ${names(unresolved, label)}`;
    } else if (blocked) {
      state = "blocked";
      reason = shows(blocked) && blocked.disposition?.state === "blocked" ? blocked.disposition.reason : "A teammate's requested work is blocked";
    } else if (failed.length) {
      state = "failed";
      reason = `${plural(failed.length, "teammate task", "teammate tasks")} did not complete (${names(failed, label)})`;
    } else reason = `${leadName} finished`;
  } else {
    state = lead.outcome === "stalled" ? "stalled" : "failed";
    reason = `${leadName}'s work ended ${lead.outcome === "stopped" ? "because it was stopped" : `as ${lead.outcome ?? lead.status}`}${lead.outcomeDetail ? `: ${lead.outcomeDetail}` : ""}`;
  }

  return { state, reason, starts, counts, parked, asking };
}

export function jobView(input: JobInput): JobView {
  const { state, reason, starts, counts, parked, asking } = jobState(input);
  const nameOf = (botId: string) => input.nameOf(botId) ?? botId;
  const shows = (row: Assignment) => input.visible(row.assignee.destination.threadId);
  const { conversation } = input;
  const sourceRequest = (row: Assignment) => !row.parentId && shows(row) ? row.brief.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  const byId = new Map(input.rows.map(row => [row.id, row]));
  const within = (row: Assignment, scopeId: string): boolean => {
    const seen = new Set<string>();
    for (let node: Assignment | undefined = row; node && !seen.has(node.id); node = node.parentId ? byId.get(node.parentId) : undefined) {
      if (node.id === scopeId) return true;
      seen.add(node.id);
    }
    return false;
  };
  const requestOrder = new Map([...(input.requestMessageIds ?? [])].map((id, index) => [id, index]));
  const sourceRoots = input.rows.filter(row => starts.has(row.id) && row.assignee.destination.threadId === input.threadId
    && (input.sourceBotId === undefined || row.assignee.botId === input.sourceBotId) && shows(row))
    .sort((a, b) => {
      const left = a.requestMessageId ? requestOrder.get(a.requestMessageId) : undefined;
      const right = b.requestMessageId ? requestOrder.get(b.requestMessageId) : undefined;
      return left !== undefined && right !== undefined ? left - right : a.createdAt - b.createdAt;
    });
  const currentRoot = sourceRoots.findLast(row => row.parentId !== undefined || input.requestMessageIds === undefined
    || (row.requestMessageId !== undefined && input.requestMessageIds.has(row.requestMessageId)));
  const current: JobView["current"] = currentRoot ? (() => {
    const summary = jobState({ ...input, rows: input.rows.filter(row => within(row, currentRoot.id)), scopes: [currentRoot.id],
      conversation: ended(currentRoot) ? { kind: conversation.kind, busy: false, queued: 0 } : conversation });
    return { rootId: currentRoot.id, ...(currentRoot.requestMessageId ? { requestMessageId: currentRoot.requestMessageId } : {}), status: currentRoot.status,
      ...(currentRoot.outcome ? { outcome: currentRoot.outcome } : {}), state: summary.state, reason: summary.reason,
      ...(currentRoot.status === "completed" && currentRoot.disposition === undefined && summary.state === "completed" ? { legacyTaskOutcome: true as const } : {}),
      ...(sourceRequest(currentRoot) ? { sourceRequest: sourceRequest(currentRoot) } : {}) };
  })() : null;
  const unconfirmedRows = input.rows.filter(row => row.office?.attempts.some(attempt => attempt.state === "uncertain"
    || (ended(row) && (attempt.state === "consumed" || attempt.consumedAt !== undefined) && attempt.finishedAt === undefined)));
  const unconfirmedStops = sourceRoots.filter(row => unconfirmedRows.some(member => within(member, row.id))).map(row => ({ rootId: row.id,
    ...(sourceRequest(row) ? { sourceRequest: sourceRequest(row) } : {}) }));
  const shown = input.rows.filter(shows);
  const listed = shown.slice(-NODES_SHOWN);
  const ordered = [...listed.filter((row) => starts.has(row.id)), ...listed.filter((row) => !starts.has(row.id))];
  const tally = { queued: 0, running: 0, waiting: 0, needsInput: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of input.rows) {
    if (row.status === "needs_input") tally.needsInput += 1;
    else if (row.status === "resume") tally.queued += 1;
    else tally[row.status] += 1;
  }
  const version = createHash("sha256").update(JSON.stringify([
    state, conversation.busy, conversation.activity ?? "", conversation.queued, asking.map((row) => row.id),
    input.rows.map((row) => [row.id, row.status, row.outcome ?? "", row.executions, row.question ?? "", row.disposition ?? null, sourceRequest(row)]),
    current, unconfirmedStops,
  ])).digest("base64url").slice(0, 16);
  const node = (row: Assignment): JobNode => {
    const { destination } = row.assignee;
    const title = input.titleOf(row);
    const result = ended(row) || row.status === "waiting" || row.status === "needs_input" ? row.result : "";
    return {
      id: row.id, rootId: row.rootId, ...(row.parentId ? { parentId: row.parentId } : {}), depth: row.depth,
      botId: row.assignee.botId, botName: nameOf(row.assignee.botId), threadId: destination.threadId,
      ...(title ? { threadTitle: title } : {}), ...(destination.groupId ? { groupId: destination.groupId } : {}),
      status: row.status, ...(row.disposition ? { disposition: row.disposition } : {}), ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.outcomeDetail ? { outcomeDetail: row.outcomeDetail } : {}),
      ...(row.question ? { question: row.question } : {}), mode: row.mode, reply: row.reply,
      awaited: input.scope === "job" ? counts(row) : starts.has(row.id),
      createdAt: row.createdAt, ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
      ...(row.finishedAt !== undefined ? { finishedAt: row.finishedAt } : {}), executions: row.executions,
      ...(result ? { result: input.full || result.length <= RESULT_CLIP ? result : `${result.slice(0, RESULT_CLIP)}…` } : {}),
      ...(sourceRequest(row) ? { sourceRequest: sourceRequest(row) } : {}),
    };
  };
  return {
    threadId: input.threadId, scope: input.scope, since: input.since, now: input.now, state, reason, version, conversation, current, unconfirmedStops,
    roots: [...input.scopes], nodes: ordered.map(node), hidden: input.rows.length - shown.length, counts: tally,
    needsInput: [...parked, ...asking].filter((row) => input.visible(row.assignee.destination.threadId)).map((row) => ({
      id: row.id, botId: row.assignee.botId, botName: nameOf(row.assignee.botId), threadId: row.assignee.destination.threadId,
      question: row.question ?? "An approval is waiting in its conversation",
    })),
  };
}
